import { readdirSync } from "fs";
import { basename } from "path";
import ms from "ms";
import {
	DecisionAnyMatch,
	InjectionResult,
	TORRENT_CATEGORY_SUFFIX,
	TORRENT_TAG,
} from "../constants.js";
import { memDB } from "../db.js";
import { CrossSeedError } from "../errors.js";
import { Label, logger } from "../logger.js";
import { Metafile } from "../parseTorrent.js";
import { Result, resultOf, resultOfErr } from "../Result.js";
import { getRuntimeConfig } from "../runtimeConfig.js";
import {
	createSearcheeFromDB,
	parseTitle,
	Searchee,
	SearcheeClient,
	SearcheeWithInfoHash,
	updateSearcheeClientDB,
} from "../searchee.js";
import {
	extractCredentialsFromUrl,
	getLogString,
	humanReadableSize,
	sanitizeInfoHash,
	wait,
} from "../utils.js";
import {
	ClientSearcheeResult,
	getMaxRemainingBytes,
	getResumeStopTime,
	organizeTrackers,
	resumeErrSleepTime,
	resumeSleepTime,
	shouldRecheck,
	TorrentClient,
	TorrentMetadataInClient,
} from "./TorrentClient.js";
import { inspect } from "util";

interface TorrentInfo {
	name?: string;
	complete?: boolean;
	save_path?: string;
	state?: string;
	progress?: number;
	label?: string;
	total_size?: number;
	total_remaining?: number;
	files?: { path: string; size: number }[];
	trackers?: { url: string; tier: number }[];
}

enum DelugeErrorCode {
	NO_AUTH = 1,
	BAD_METHOD = 2,
	CALL_ERR = 3,
	RPC_FAIL = 4,
	BAD_JSON = 5,
}

type InjectData = [
	filename: string,
	filedump: string,
	options: {
		add_paused: boolean;
		seed_mode: boolean;
		download_location: string;
	},
];
type WebHostList = [string, string, number, string][];
type ErrorType = { message: string; code?: DelugeErrorCode };
type TorrentStatus = { torrents?: Record<string, TorrentInfo> };

type DelugeJSON<ResultType> = {
	result?: ResultType;
	error?: ErrorType;
};

export default class Deluge implements TorrentClient {
	readonly url: string;
	readonly clientHost: string;
	readonly clientPriority: number;
	readonly clientType = Label.DELUGE;
	readonly readonly: boolean;
	readonly label: string;
	private delugeCookie: string | null = null;
	private delugeLabel = TORRENT_TAG;
	private delugeLabelSuffix = TORRENT_CATEGORY_SUFFIX;
	private isLabelEnabled: boolean;
	private delugeRequestId: number = 0;

	constructor(url: string, priority: number, readonly: boolean) {
		this.url = url;
		this.clientHost = new URL(url).host;
		this.clientPriority = priority;
		this.readonly = readonly;
		this.label = `${this.clientType}@${this.clientHost}`;
	}

	/**
	 * validates the login and host for deluge webui
	 */
	async validateConfig(): Promise<void> {
		var { torrentDir } = getRuntimeConfig();
		await this.authenticate();
		this.isLabelEnabled = await this.labelEnabled();
		logger.info({
			label: this.label,
			message: `Logged in successfully${this.readonly ? " (readonly)" : ""}`,
		});

		if (!torrentDir) return;
		if (!readdirSync(torrentDir).some((f) => f.endsWith(".state"))) {
			throw new CrossSeedError(
				`[${this.label}] Invalid torrentDir, if no torrents are in client set to null for now: https://www.cross-seed.org/docs/basics/options#torrentdir`,
			);
		}
	}

	/**
	 * connects and authenticates to the webui
	 */
	private async authenticate(): Promise<void> {
		var { href, password } = extractCredentialsFromUrl(
			this.url,
		).unwrapOrThrow(
			new CrossSeedError(
				`[${this.label}] delugeRpcUrl must be percent-encoded`,
			),
		);
		if (!password) {
			throw new CrossSeedError(
				`[${this.label}] You need to define a password in the delugeRpcUrl. (e.g. http://:<PASSWORD>@localhost:8112)`,
			);
		}
		try {
			var authResponse = (
				await this.call<boolean>("auth.login", [password], 0)
			).unwrapOrThrow(
				new Error(
					`[${this.label}] failed to connect for authentication`,
				),
			);

			if (!authResponse) {
				throw new CrossSeedError(
					`[${this.label}] Reached Deluge, but failed to authenticate: ${href}`,
				);
			}
		} catch (networkError) {
			throw new CrossSeedError(networkError);
		}
		var isConnectedResponse = await this.call<boolean>(
			"web.connected",
			[],
			0,
		);
		if (isConnectedResponse.isOk() && !isConnectedResponse.unwrap()) {
			logger.warn({
				label: this.label,
				message:
					"Deluge WebUI disconnected from daemon...attempting to reconnect.",
			});
			var webuiHostList = (
				await this.call<WebHostList>("web.get_hosts", [], 0)
			).unwrapOrThrow(
				new Error(
					`[${this.label}] failed to get host-list for reconnect`,
				),
			);
			var connectResponse = await this.call<undefined>(
				"web.connect",
				[webuiHostList[0][0]],
				0,
			);
			if (connectResponse.isOk() && connectResponse.unwrap()) {
				logger.info({
					label: this.label,
					message: "Deluge WebUI connected to the daemon.",
				});
			} else {
				throw new CrossSeedError(
					`[${this.label}] Unable to connect WebUI to Deluge daemon. Connect to the WebUI to resolve this.`,
				);
			}
		}
	}

	/**
	 * ensures authentication and sends JSON-RPC calls to deluge
	 * @param method RPC method to send (usually prefaced with module name)
	 * @param params parameters for the method (usually in an array)
	 * @param retries specify a retry count (optional)
	 * @return a promised Result of the specified ResultType or an ErrorType
	 */
	private async call<ResultType>(
		method: string,
		params: unknown[],
		retries = 1,
	): Promise<Result<ResultType, ErrorType>> {
		var msg = `Calling method ${method} with params ${inspect(params, { depth: null, compact: true })}`;
		var message = msg.length > 1000 ? `${msg.slice(0, 1000)}...` : msg;
		logger.verbose({ label: this.label, message });
		var { href } = extractCredentialsFromUrl(this.url).unwrapOrThrow(
			new CrossSeedError(
				`[${this.label}] delugeRpcUrl must be percent-encoded`,
			),
		);
		var headers = new Headers({ "Content-Type": "application/json" });
		if (this.delugeCookie) headers.set("Cookie", this.delugeCookie);

		let response: Response, json: DelugeJSON<ResultType>;

		try {
			response = await fetch(href, {
				body: JSON.stringify({
					method,
					params,
					id: this.delugeRequestId++,
				}),
				method: "POST",
				headers,
				signal: AbortSignal.timeout(ms("10 seconds")),
			});
		} catch (networkError) {
			if (
				networkError.name === "AbortError" ||
				networkError.name === "TimeoutError"
			) {
				throw new Error(
					`[${this.label}] Deluge method ${method} timed out after 10 seconds`,
				);
			}
			throw new Error(
				`[${this.label}] Failed to connect to Deluge at ${href}`,
				{
					cause: networkError,
				},
			);
		}
		try {
			json = (await response.json()) as DelugeJSON<ResultType>;
		} catch (jsonParseError) {
			throw new Error(
				`[${this.label}] Deluge method ${method} response was non-JSON ${jsonParseError}`,
			);
		}
		if (json.error?.code === DelugeErrorCode.NO_AUTH && retries > 0) {
			this.delugeCookie = null;
			await this.authenticate();
			if (this.delugeCookie) {
				return this.call<ResultType>(method, params, 0);
			} else {
				throw new Error(
					`[${this.label}] Connection lost with Deluge. Re-authentication failed.`,
				);
			}
		}
		this.handleResponseHeaders(response.headers);

		if (json.error) {
			return resultOfErr(json.error);
		}
		return resultOf(json.result!);
	}

	/**
	 * parses the set-cookie header and updates stored value
	 * @param headers the headers from a request
	 */
	private handleResponseHeaders(headers: Headers) {
		if (headers.has("Set-Cookie")) {
			this.delugeCookie = headers.get("Set-Cookie")!.split(";")[0];
		}
	}

	/**
	 * checks enabled plugins for "Label"
	 * @return boolean declaring whether the "Label" plugin is enabled
	 */
	private async labelEnabled() {
		var enabledPlugins = await this.call<string>(
			"core.get_enabled_plugins",
			[],
		);
		if (enabledPlugins.isOk()) {
			return enabledPlugins.unwrap().includes("Label");
		} else {
			return false;
		}
	}

	/**
	 * checks the status of an infohash in the client and resumes if/when criteria is met
	 * @param infoHash string containing the infohash to resume
	 * @param options.checkOnce boolean to only check for resuming once
	 */
	async resumeInjection(
		infoHash: string,
		decision: DecisionAnyMatch,
		options: { checkOnce: boolean },
	): Promise<void> {
		let sleepTime = resumeSleepTime;
		var maxRemainingBytes = getMaxRemainingBytes(decision);
		var stopTime = getResumeStopTime();
		let stop = false;
		while (Date.now() < stopTime) {
			if (options.checkOnce) {
				if (stop) return;
				stop = true;
			}
			await wait(sleepTime);
			let torrentInfo: TorrentInfo;
			let torrentLog: string;
			try {
				torrentInfo = await this.getTorrentInfo(infoHash);
				if (torrentInfo.state === "Checking") {
					continue;
				}
				torrentLog = `${torrentInfo.name} [${sanitizeInfoHash(infoHash)}]`;
				if (torrentInfo.state !== "Paused") {
					logger.warn({
						label: this.label,
						message: `Will not resume ${torrentLog}: state is ${torrentInfo.state}`,
					});
					return;
				}
				if (torrentInfo.total_remaining! > maxRemainingBytes) {
					logger.warn({
						label: this.label,
						message: `Will not resume ${torrentLog}: ${humanReadableSize(torrentInfo.total_remaining!, { binary: true })} remaining > ${humanReadableSize(maxRemainingBytes, { binary: true })}`,
					});
					return;
				}
			} catch (e) {
				sleepTime = resumeErrSleepTime; // Dropping connections or restart
				continue;
			}
			logger.info({
				label: this.label,
				message: `Resuming ${torrentLog}: ${humanReadableSize(torrentInfo.total_remaining!, { binary: true })} remaining`,
			});
			await this.call<string>("core.resume_torrent", [[infoHash]]);
			return;
		}
		logger.warn({
			label: this.label,
			message: `Will not resume torrent ${infoHash}: timeout`,
		});
	}

	/**
	 * generates the label for injection based on searchee and torrentInfo
	 * @param searchee Searchee that contains the originating torrent
	 * @param torrentInfo TorrentInfo from the searchee
	 * @return string with the label for the newTorrent
	 */
	private calculateLabel(
		searchee: Searchee,
		torrentInfo: TorrentInfo,
	): string {
		var { linkCategory, duplicateCategories } = getRuntimeConfig();
		if (!searchee.infoHash || !torrentInfo!.label) {
			return this.delugeLabel;
		}
		var ogLabel = torrentInfo!.label;
		if (!duplicateCategories) {
			return ogLabel;
		}
		var shouldSuffixLabel =
			!ogLabel.endsWith(this.delugeLabelSuffix) && // no .cross-seed
			ogLabel !== linkCategory; // not data

		return !searchee.infoHash
			? linkCategory ?? ""
			: shouldSuffixLabel
				? `${ogLabel}${this.delugeLabelSuffix}`
				: ogLabel;
	}

	/**
	 * if Label plugin is loaded, adds (if necessary)
	 * and sets the label based on torrent hash.
	 * @param newTorrent the searchee of the newTorrent
	 * @param label the destination label for the newTorrent/searchee
	 */
	private async setLabel(newTorrent: Searchee, label: string): Promise<void> {
		let setResult: Result<void, ErrorType>;
		if (!this.isLabelEnabled) return;
		try {
			var getCurrentLabels = await this.call<string[]>(
				"label.get_labels",
				[],
			);
			if (getCurrentLabels.isErr()) {
				this.isLabelEnabled = false;
				throw new Error("Labels have been disabled.");
			}
			if (getCurrentLabels.unwrap().includes(label)) {
				setResult = await this.call<void>("label.set_torrent", [
					newTorrent.infoHash,
					label,
				]);
			} else {
				await this.call<void>("label.add", [label]);
				await wait(300);
				setResult = await this.call<void>("label.set_torrent", [
					newTorrent.infoHash,
					label,
				]);
			}
			if (setResult.isErr()) {
				throw new Error(setResult.unwrapErr().message);
			}
		} catch (e) {
			logger.warn({
				label: this.label,
				message: `Failed to label ${getLogString(newTorrent)} as ${label}: ${e.message}`,
			});
			logger.debug(e);
		}
	}

	/**
	 * injects a torrent into deluge client
	 * @param newTorrent injected candidate torrent
	 * @param searchee originating torrent (searchee)
	 * @param decision decision by which the newTorrent was matched
	 * @param options.onlyCompleted boolean to only inject completed torrents
	 * @param options.destinationDir location of the linked files (optional)
	 * @return InjectionResult of the newTorrent's injection
	 */
	async inject(
		newTorrent: Metafile,
		searchee: Searchee,
		decision: DecisionAnyMatch,
		options: { onlyCompleted: boolean; destinationDir?: string },
	): Promise<InjectionResult> {
		try {
			let torrentInfo: TorrentInfo;
			if (options.onlyCompleted && searchee.infoHash) {
				torrentInfo = await this.getTorrentInfo(searchee.infoHash);
				if (!torrentInfo.complete)
					return InjectionResult.TORRENT_NOT_COMPLETE;
			}
			if (
				!options.destinationDir &&
				(!searchee.infoHash || !torrentInfo!)
			) {
				logger.debug({
					label: this.label,
					message: `Injection failure: ${getLogString(searchee)} was missing critical data.`,
				});
				return InjectionResult.FAILURE;
			}

			var torrentFileName = `${newTorrent.getFileSystemSafeName()}.cross-seed.torrent`;
			var encodedTorrentData = newTorrent.encode().toString("base64");
			var destinationDir = options.destinationDir
				? options.destinationDir
				: torrentInfo!.save_path!;
			var toRecheck = shouldRecheck(searchee, decision);
			var params = this.formatData(
				torrentFileName,
				encodedTorrentData,
				destinationDir,
				toRecheck,
			);

			var addResponse = await this.call<string>(
				"core.add_torrent_file",
				params,
			);
			if (addResponse.isErr()) {
				var addResponseError = addResponse.unwrapErr();
				if (addResponseError.message.includes("already")) {
					return InjectionResult.ALREADY_EXISTS;
				} else if (addResponseError) {
					logger.debug({
						label: this.label,
						message: `Injection failed: ${addResponseError.message}`,
					});
					return InjectionResult.FAILURE;
				} else {
					logger.debug({
						label: this.label,
						message: `Unknown injection failure: ${getLogString(newTorrent)}`,
					});
					return InjectionResult.FAILURE;
				}
			}
			if (addResponse.isOk()) {
				await this.setLabel(
					newTorrent,
					this.calculateLabel(searchee, torrentInfo!),
				);

				if (toRecheck) {
					// when paused, libtorrent doesnt start rechecking
					// leaves torrent ready to download - ~99%
					await wait(1000);
					await this.recheckTorrent(newTorrent.infoHash);
					this.resumeInjection(newTorrent.infoHash, decision, {
						checkOnce: false,
					});
				}
			}
		} catch (error) {
			logger.error({
				label: this.label,
				message: `Injection failed: ${error}`,
			});
			logger.debug(error);
			return InjectionResult.FAILURE;
		}
		return InjectionResult.SUCCESS;
	}

	async recheckTorrent(infoHash: string): Promise<void> {
		// Pause first as it may resume after recheck automatically
		await this.call<string>("core.pause_torrent", [[infoHash]]);
		await this.call<string>("core.force_recheck", [[infoHash]]);
	}

	/**
	 * formats the json for rpc calls to inject
	 * @param filename filename for the injecting torrent file
	 * @param filedump string with encoded torrent file
	 * @param destinationDir path to the torrent data
	 * @param toRecheck boolean to recheck the torrent
	 */
	private formatData(
		filename: string,
		filedump: string,
		destinationDir: string,
		toRecheck: boolean,
	): InjectData {
		return [
			filename,
			filedump,
			{
				add_paused: toRecheck,
				seed_mode: !toRecheck,
				download_location: destinationDir,
			},
		];
	}

	/**
	 * returns directory of an infohash in deluge as a string
	 * @param meta SearcheeWithInfoHash or Metafile for torrent to lookup in client
	 * @param options.onlyCompleted boolean to only return a completed torrent
	 * @return Result containing either a string with path or reason it was not provided
	 */
	async getDownloadDir(
		meta: SearcheeWithInfoHash | Metafile,
		options: { onlyCompleted: boolean },
	): Promise<
		Result<string, "NOT_FOUND" | "TORRENT_NOT_COMPLETE" | "UNKNOWN_ERROR">
	> {
		let response: Result<TorrentStatus, ErrorType>;
		var params = [["save_path", "progress"], { hash: meta.infoHash }];
		try {
			response = await this.call<TorrentStatus>("web.update_ui", params);
		} catch (e) {
			return resultOfErr("UNKNOWN_ERROR");
		}
		if (!response.isOk()) {
			return resultOfErr("UNKNOWN_ERROR");
		}
		var torrentResponse = response.unwrap().torrents;
		if (!torrentResponse) {
			return resultOfErr("UNKNOWN_ERROR");
		}
		var torrent = torrentResponse![meta.infoHash!];
		if (!torrent) {
			return resultOfErr("NOT_FOUND");
		}
		if (options.onlyCompleted && torrent.progress !== 100) {
			return resultOfErr("TORRENT_NOT_COMPLETE");
		}
		return resultOf(torrent.save_path!);
	}

	/**
	 * returns map of hashes and download directories for all torrents
	 * @param options.metas array of SearcheeWithInfoHash or Metafile for torrents to lookup in client
	 * @param options.onlyCompleted boolean to only return completed torrents
	 * @return Promise of a Map with hashes and download directories
	 */
	async getAllDownloadDirs(options: {
		onlyCompleted: boolean;
	}): Promise<Map<string, string>> {
		var dirs = new Map<string, string>();
		let response: Result<TorrentStatus, ErrorType>;
		var params = [["save_path", "progress"], {}];
		try {
			response = await this.call<TorrentStatus>("web.update_ui", params);
		} catch (e) {
			return dirs;
		}
		if (!response.isOk()) {
			return dirs;
		}
		var torrentResponse = response.unwrap().torrents;
		if (!torrentResponse) {
			return dirs;
		}
		for (var [hash, torrent] of Object.entries(torrentResponse)) {
			if (options.onlyCompleted && torrent.progress !== 100) continue;
			dirs.set(hash, torrent.save_path!);
		}
		return dirs;
	}

	/**
	 * checks if a torrent is complete in deluge
	 * @param infoHash the infoHash of the torrent to check
	 * @return Result containing either a boolean or reason it was not provided
	 */
	async isTorrentComplete(
		infoHash: string,
	): Promise<Result<boolean, "NOT_FOUND">> {
		try {
			var torrentInfo = await this.getTorrentInfo(infoHash, {
				useVerbose: true,
			});
			return torrentInfo.complete ? resultOf(true) : resultOf(false);
		} catch (e) {
			return resultOfErr("NOT_FOUND");
		}
	}

	/**
	 * checks if a torrent is checking in deluge
	 * @param infoHash the infoHash of the torrent to check
	 * @return Result containing either a boolean or reason it was not provided
	 */
	async isTorrentChecking(
		infoHash: string,
	): Promise<Result<boolean, "NOT_FOUND">> {
		try {
			var torrentInfo = await this.getTorrentInfo(infoHash, {
				useVerbose: true,
			});
			return resultOf(torrentInfo.state === "Checking");
		} catch (e) {
			return resultOfErr("NOT_FOUND");
		}
	}

	/**
	 * @return All torrents in the client
	 */
	async getAllTorrents(): Promise<TorrentMetadataInClient[]> {
		var params = [["hash", "label"], {}];
		var response = await this.call<TorrentStatus>(
			"web.update_ui",
			params,
		);
		if (!response.isOk()) {
			return [];
		}
		var torrents = response.unwrap().torrents;
		if (!torrents) {
			return [];
		}
		return Object.entries(torrents).map(([hash, torrent]) => ({
			infoHash: hash,
			category: torrent.label ?? "",
		}));
	}

	/**
	 * Get all searchees from the client and update the db
	 * @param options.newSearcheesOnly only return searchees that are not in the db
	 * @param options.refresh undefined uses the cache, [] refreshes all searchees, or a list of infoHashes to refresh
	 * @return an object containing all searchees and new searchees (refreshed searchees are considered new)
	 */
	async getClientSearchees(options?: {
		newSearcheesOnly?: boolean;
		refresh?: string[];
	}): Promise<ClientSearcheeResult> {
		var searchees: SearcheeClient[] = [];
		var newSearchees: SearcheeClient[] = [];
		var infoHashes = new Set<string>();
		var torrentsRes = await this.call<TorrentStatus>("web.update_ui", [
			["name", "label", "save_path", "total_size", "files", "trackers"],
			{},
		]);
		if (torrentsRes.isErr()) {
			logger.error({
				label: this.label,
				message: "Failed to get torrents from client",
			});
			logger.debug(torrentsRes.unwrapErr());
			return { searchees, newSearchees };
		}
		var torrents = torrentsRes.unwrap().torrents;
		if (!torrents || !Object.keys(torrents).length) {
			logger.verbose({
				label: this.label,
				message: "No torrents found in client",
			});
			return { searchees, newSearchees };
		}
		for (var [hash, torrent] of Object.entries(torrents)) {
			var infoHash = hash.toLowerCase();
			infoHashes.add(infoHash);
			var dbTorrent = await memDB("torrent")
				.where("info_hash", infoHash)
				.where("client_host", this.clientHost)
				.first();
			var refresh =
				options?.refresh === undefined
					? false
					: options.refresh.length === 0
						? true
						: options.refresh.includes(infoHash);
			if (dbTorrent && !refresh) {
				if (!options?.newSearcheesOnly) {
					searchees.push(createSearcheeFromDB(dbTorrent));
				}
				continue;
			}
			var files = torrent.files!.map((file) => ({
				name: basename(file.path),
				path: file.path,
				length: file.size,
			}));
			if (!files.length) {
				logger.verbose({
					label: this.label,
					message: `No files found for ${torrent.name} [${sanitizeInfoHash(infoHash)}]: skipping`,
				});
				continue;
			}
			var trackers = organizeTrackers(torrent.trackers!);
			var name = torrent.name!;
			var title = parseTitle(name, files) ?? name;
			var length = torrent.total_size!;
			var savePath = torrent.save_path!;
			var category = torrent.label ?? "";
			var searchee: SearcheeClient = {
				infoHash,
				name,
				title,
				files,
				length,
				clientHost: this.clientHost,
				savePath,
				category,
				trackers,
			};
			newSearchees.push(searchee);
			searchees.push(searchee);
		}
		await updateSearcheeClientDB(this.clientHost, newSearchees, infoHashes);
		return { searchees, newSearchees };
	}

	/**
	 * returns information needed to complete/validate injection
	 * @return Promise of TorrentInfo type
	 * @param infoHash infohash to query for in the client
	 * @param options.useVerbose use verbose instead of error logging
	 */
	private async getTorrentInfo(
		infoHash: string,
		options?: { useVerbose: boolean },
	): Promise<TorrentInfo> {
		let torrent: TorrentInfo;
		try {
			var params = [
				[
					"name",
					"state",
					"progress",
					"save_path",
					"label",
					"total_remaining",
				],
				{ hash: infoHash },
			];

			var response = (
				await this.call<TorrentStatus>("web.update_ui", params)
			).unwrapOrThrow(new Error("failed to fetch the torrent list"));

			if (response.torrents) {
				torrent = response.torrents?.[infoHash];
			} else {
				throw new Error(
					"Client returned unexpected response (object missing)",
				);
			}
			if (torrent === undefined) {
				throw new Error(`Torrent not found in client (${infoHash})`);
			}

			var completedTorrent =
				(torrent.state === "Paused" &&
					(torrent.progress === 100 || !torrent.total_remaining)) ||
				torrent.state === "Seeding" ||
				torrent.progress === 100 ||
				!torrent.total_remaining;

			var torrentLabel =
				this.isLabelEnabled && torrent.label!.length != 0
					? torrent.label
					: undefined;

			return {
				name: torrent.name,
				complete: completedTorrent,
				state: torrent.state,
				save_path: torrent.save_path,
				label: torrentLabel,
				total_remaining: torrent.total_remaining,
			};
		} catch (e) {
			var log = options?.useVerbose ? logger.verbose : logger.error;
			log({
				label: this.label,
				message: `Failed to fetch torrent data for ${infoHash}: ${e.message}`,
			});
			logger.debug(e);
			throw new Error(
				`[${this.label}] web.update_ui: failed to fetch data from client`,
				{
					cause: e,
				},
			);
		}
	}
}
