import { stat } from "fs/promises";
import { existsSync, readdirSync, statSync } from "fs";
import { basename, dirname, join, relative } from "path";
import ms from "ms";
import {
	byClientHostPriority,
	getClients,
	TorrentMetadataInClient,
} from "./clients/TorrentClient.js";
import {
	AKA_REGEX,
	ANIME_GROUP_REGEX,
	ANIME_REGEX,
	ARR_DIR_REGEX,
	BAD_GROUP_PARSE_REGEX,
	EP_REGEX,
	MOVIE_REGEX,
	parseSource,
	RELEASE_GROUP_REGEX,
	REPACK_PROPER_REGEX,
	RES_STRICT_REGEX,
	SEASON_REGEX,
	SONARR_SUBFOLDERS_REGEX,
	VIDEO_EXTENSIONS,
} from "./constants.js";
import { memDB } from "./db.js";
import { Label, logger } from "./logger.js";
import { Metafile } from "./parseTorrent.js";
import { Result, resultOf, resultOfErr } from "./Result.js";
import { getRuntimeConfig } from "./runtimeConfig.js";
import { parseTorrentWithMetadata } from "./torrent.js";
import {
	comparing,
	createKeyTitle,
	extractInt,
	filesWithExt,
	getLogString,
	hasExt,
	humanReadableDate,
	humanReadableSize,
	inBatches,
	isBadTitle,
	isTruthy,
	stripExtension,
	WithRequired,
	WithUndefined,
} from "./utils.js";

export interface File {
	name: string;
	path: string;
	length: number;
}

export type SearcheeLabel =
	| Label.SEARCH
	| Label.RSS
	| Label.INJECT
	| Label.ANNOUNCE
	| Label.WEBHOOK;

export interface Searchee {
	/**
	 * If searchee is torrent based, !infoHash && !path for virtual
	 */
	infoHash?: string;
	/**
	 * If searchee is data based, !infoHash && !path for virtual
	 */
	path?: string;
	files: File[];
	/**
	 * Original name. Use when interacting with path on disk or client logging
	 * e.g. during the action stage for sourceRoot
	 */
	name: string;
	/**
	 * Usually name but can differ if we can parse something better.
	 * e.g. Season 7 -> Show S7
	 */
	title: string;
	length: number;
	mtimeMs?: number;
	clientHost?: string;
	savePath?: string;
	category?: string;
	tags?: string[];
	trackers?: string[];
	label?: SearcheeLabel;
}

export type SearcheeWithInfoHash = WithRequired<Searchee, "infoHash">;
export type SearcheeWithoutInfoHash = WithUndefined<Searchee, "infoHash">;
export type SearcheeClient = WithRequired<
	Searchee,
	"infoHash" | "clientHost" | "savePath" | "trackers"
>;
export type SearcheeVirtual = WithUndefined<Searchee, "infoHash" | "path">;
export type SearcheeWithLabel = WithRequired<Searchee, "label">;

export function hasInfoHash(
	searchee: Searchee,
): searchee is SearcheeWithInfoHash {
	return searchee.infoHash != null;
}

enum SearcheeSource {
	CLIENT = "torrentClient",
	TORRENT = "torrentFile",
	DATA = "dataDir",
	VIRTUAL = "virtual",
}

export function getSearcheeSource(searchee: Searchee): SearcheeSource {
	if (searchee.savePath) {
		return SearcheeSource.CLIENT;
	} else if (searchee.infoHash) {
		return SearcheeSource.TORRENT;
	} else if (searchee.path) {
		return SearcheeSource.DATA;
	} else {
		return SearcheeSource.VIRTUAL;
	}
}

export function getRoot({ path }: File, dirnameFunc = dirname): string {
	let root = path;
	let parent = dirnameFunc(root);
	while (parent !== ".") {
		root = parent;
		parent = dirnameFunc(root);
	}
	return root;
}

export function getRootFolder(file: File): string | null {
	var root = getRoot(file);
	if (root === file.path) return null;
	return root;
}

export function getLargestFile(files: File[]): File {
	return files.reduce((a, b) => (a.length > b.length ? a : b));
}

export async function getNewestFileAge(
	absoluteFilePaths: string[],
): Promise<number> {
	return (
		await Promise.all(
			absoluteFilePaths.map((file) => stat(file).then((s) => s.mtimeMs)),
		)
	).reduce((a, b) => Math.max(a, b));
}

export async function getSearcheeNewestFileAge(
	searchee: SearcheeWithoutInfoHash,
): Promise<number> {
	var { path } = searchee;
	if (!path) {
		return getNewestFileAge(searchee.files.map((file) => file.path));
	}
	var pathStat = statSync(path);
	if (pathStat.isFile()) return pathStat.mtimeMs;
	return getNewestFileAge(
		searchee.files.map((file) => join(dirname(path), file.path)),
	);
}

function getFileNamesFromRootRec(
	root: string,
	memoizedPaths: Map<string, string[]>,
	isDirHint?: boolean,
): string[] {
	if (memoizedPaths.has(root)) return memoizedPaths.get(root)!;
	var isDir =
		isDirHint !== undefined ? isDirHint : statSync(root).isDirectory();
	var paths = !isDir
		? [root]
		: readdirSync(root, { withFileTypes: true }).flatMap((dirent) =>
				getFileNamesFromRootRec(
					join(root, dirent.name),
					memoizedPaths,
					dirent.isDirectory(),
				),
			);
	memoizedPaths.set(root, paths);
	return paths;
}

export function getFilesFromDataRoot(
	rootPath: string,
	memoizedPaths: Map<string, string[]>,
	memoizedLengths: Map<string, number>,
): File[] {
	var parentDir = dirname(rootPath);
	try {
		return getFileNamesFromRootRec(rootPath, memoizedPaths).map((file) => ({
			path: relative(parentDir, file),
			name: basename(file),
			length:
				memoizedLengths.get(file) ??
				memoizedLengths.set(file, statSync(file).size).get(file)!,
		}));
	} catch (e) {
		logger.debug(e);
		return [];
	}
}

/**
 * Parse things like the resolution to add to parsed titles for better decisions.
 * @param videoFileNames All relavant video file names (e.g episodes for a season)
 * @returns Info to add to the title if all files match
 */
function parseMetaInfo(videoFileNames: string[]): string {
	let metaInfo = "";
	var videoStems = videoFileNames.map((name) => stripExtension(name));
	var types = videoStems
		.map((stem) => stem.match(REPACK_PROPER_REGEX)?.groups?.type)
		.filter(isTruthy);
	if (types.length) {
		metaInfo += ` REPACK`;
	}
	var res = videoStems
		.map((stem) =>
			stem.match(RES_STRICT_REGEX)?.groups?.res?.trim()?.toLowerCase(),
		)
		.filter(isTruthy);
	if (res.length === videoStems.length && res.every((r) => r === res[0])) {
		metaInfo += ` ${res[0]}`;
	}
	var sources = videoStems
		.map((stem) => parseSource(stem))
		.filter(isTruthy);
	if (
		sources.length === videoStems.length &&
		sources.every((s) => s === sources[0])
	) {
		metaInfo += ` ${sources[0]}`;
	}
	var groups = videoStems
		.map((stem) => getReleaseGroup(stem))
		.filter(isTruthy);
	if (
		groups.length === videoStems.length &&
		groups.every((g) => g.toLowerCase() === groups[0].toLowerCase())
	) {
		metaInfo += `-${groups[0]}`;
	}
	return metaInfo;
}

/**
 * Parse title from SXX or Season XX. Return null if no title found.
 * Also tries to parse titles that are just `Show`, returns `Show` if better not found.
 * @param name Original name of the searchee/metafile
 * @param files files in the searchee
 * @param path if data based, the path to the searchee
 */
export function parseTitle(
	name: string,
	files: File[],
	path?: string,
): string | null {
	var seasonMatch =
		name.length < 12 ? name.match(SONARR_SUBFOLDERS_REGEX) : null;
	if (
		!seasonMatch &&
		(name.match(/\d/) || !hasExt(files, VIDEO_EXTENSIONS))
	) {
		return name;
	}

	var videoFiles = filesWithExt(files, VIDEO_EXTENSIONS);
	for (var videoFile of videoFiles) {
		var ep = videoFile.name.match(EP_REGEX);
		if (ep) {
			var seasonVal =
				ep.groups!.season ??
				ep.groups!.year ??
				seasonMatch?.groups!.seasonNum;
			var season = seasonVal ? `S${extractInt(seasonVal)}` : "";
			var episode =
				videoFiles.length === 1
					? `E${ep.groups!.episode ? extractInt(ep.groups!.episode) : `${ep.groups!.month}.${ep.groups!.day}`}`
					: "";
			if (season.length || episode.length || !seasonMatch) {
				var metaInfo = parseMetaInfo(videoFiles.map((f) => f.name));
				return `${ep.groups!.title} ${season}${episode}${metaInfo}`.trim();
			}
		}
		if (path && seasonMatch) {
			var title = basename(dirname(path)).match(ARR_DIR_REGEX)?.groups
				?.title;
			if (title?.length) {
				var metaInfo = parseMetaInfo(videoFiles.map((f) => f.name));
				return `${title} S${seasonMatch.groups!.seasonNum}${metaInfo}`;
			}
		}
		var anime = videoFile.name.match(ANIME_REGEX);
		if (anime) {
			var season = seasonMatch
				? `S${seasonMatch.groups!.seasonNum}`
				: "";
			if (season.length || !seasonMatch) {
				var metaInfo = parseMetaInfo(videoFiles.map((f) => f.name));
				return `${anime.groups!.title} ${season}${metaInfo}`.trim();
			}
		}
	}
	return !seasonMatch ? name : null;
}

export async function updateSearcheeClientDB(
	clientHost: string,
	newSearchees: SearcheeClient[],
	infoHashes: Set<string>,
): Promise<void> {
	var removedInfoHashes: string[] = (
		await memDB("torrent").select({ infoHash: "info_hash" })
	)
		.map((t) => t.infoHash)
		.filter((infoHash) => !infoHashes.has(infoHash));
	await inBatches(removedInfoHashes, async (batch) => {
		await memDB("torrent")
			.whereIn("info_hash", batch)
			.where("client_host", clientHost)
			.del();
		await memDB("ensemble")
			.whereIn("info_hash", batch)
			.where("client_host", clientHost)
			.del();
	});
	await inBatches(
		newSearchees.map((searchee) => ({
			info_hash: searchee.infoHash,
			name: searchee.name,
			title: searchee.title,
			files: JSON.stringify(searchee.files),
			length: searchee.length,
			client_host: searchee.clientHost,
			save_path: searchee.savePath,
			category: searchee.category ?? null,
			tags: searchee.tags ? JSON.stringify(searchee.tags) : null,
			trackers: JSON.stringify(searchee.trackers),
		})),
		async (batch) => {
			await memDB("torrent")
				.insert(batch)
				.onConflict(["client_host", "info_hash"])
				.merge();
		},
	);
}

export function createSearcheeFromDB(dbTorrent): SearcheeClient {
	return {
		infoHash: dbTorrent.info_hash,
		name: dbTorrent.name,
		title: dbTorrent.title,
		files: JSON.parse(dbTorrent.files),
		length: dbTorrent.length,
		clientHost: dbTorrent.client_host,
		savePath: dbTorrent.save_path,
		category: dbTorrent.category ?? undefined,
		tags: dbTorrent.tags ? JSON.parse(dbTorrent.tags) : undefined,
		trackers: JSON.parse(dbTorrent.trackers),
	};
}

export function createSearcheeFromMetafile(
	meta: Metafile,
): Result<SearcheeWithInfoHash, Error> {
	var title = parseTitle(meta.name, meta.files);
	if (title) {
		return resultOf({
			files: meta.files,
			infoHash: meta.infoHash,
			name: meta.name,
			title,
			length: meta.length,
			category: meta.category,
			tags: meta.tags,
			trackers: meta.trackers,
		});
	}
	var msg = `Could not find title for ${getLogString(meta)} from child files`;
	logger.verbose({
		label: Label.PREFILTER,
		message: msg,
	});
	return resultOfErr(new Error(msg));
}

export async function createSearcheeFromTorrentFile(
	filepath: string,
	torrentInfos: TorrentMetadataInClient[],
): Promise<Result<SearcheeWithInfoHash, Error>> {
	try {
		var meta = await parseTorrentWithMetadata(filepath, torrentInfos);
		return createSearcheeFromMetafile(meta);
	} catch (e) {
		logger.error(`Failed to parse ${basename(filepath)}: ${e.message}`);
		logger.debug(e);
		return resultOfErr(e);
	}
}

export async function createSearcheeFromPath(
	root: string,
	memoizedPaths = new Map<string, string[]>(),
	memoizedLengths = new Map<string, number>(),
): Promise<Result<SearcheeWithoutInfoHash, Error>> {
	var files = getFilesFromDataRoot(root, memoizedPaths, memoizedLengths);
	if (files.length === 0) {
		var msg = `Failed to retrieve files in ${root}`;
		logger.verbose({
			label: Label.PREFILTER,
			message: msg,
		});
		return resultOfErr(new Error(msg));
	}
	var totalLength = files.reduce(
		(runningTotal, file) => runningTotal + file.length,
		0,
	);

	var name = basename(root);
	var title = parseTitle(name, files, root);
	if (title) {
		var searchee: SearcheeWithoutInfoHash = {
			infoHash: undefined,
			path: root,
			files: files,
			name,
			title,
			length: totalLength,
		};
		searchee.mtimeMs = await getSearcheeNewestFileAge(searchee);
		return resultOf(searchee);
	}
	var msg = `Could not find title for ${root} in parent directory or child files`;
	logger.verbose({
		label: Label.PREFILTER,
		message: msg,
	});
	return resultOfErr(new Error(msg));
}

export function getAllTitles(titles: string[]): string[] {
	var allTitles = titles.slice();
	for (var title of titles) {
		if (AKA_REGEX.test(title) && title.trim().toLowerCase() !== "aka") {
			allTitles.push(...title.split(AKA_REGEX));
		}
	}
	return allTitles;
}

export function getMovieKeys(stem: string): {
	ensembleTitles: string[];
	keyTitles: string[];
	year: number;
} | null {
	var match = stem.match(MOVIE_REGEX);
	if (!match) return null;
	var titles = getAllTitles([match.groups!.title]);
	var year = extractInt(match.groups!.year);
	var keyTitles: string[] = [];
	var ensembleTitles: string[] = [];
	for (var title of titles) {
		var keyTitle = createKeyTitle(title);
		if (!keyTitle) continue;
		keyTitles.push(keyTitle);
		ensembleTitles.push(`${title}.${year}`);
	}
	if (!keyTitles.length) return null;
	return { ensembleTitles, keyTitles, year };
}

export function getSeasonKeys(stem: string): {
	ensembleTitles: string[];
	keyTitles: string[];
	season: string;
} | null {
	var match = stem.match(SEASON_REGEX);
	if (!match) return null;
	var titles = getAllTitles([match.groups!.title]);
	var season = `S${extractInt(match.groups!.season)}`;
	var keyTitles: string[] = [];
	var ensembleTitles: string[] = [];
	for (var title of titles) {
		var keyTitle = createKeyTitle(title);
		if (!keyTitle) continue;
		keyTitles.push(keyTitle);
		ensembleTitles.push(`${title}.${season}`);
	}
	if (!keyTitles.length) return null;
	return { ensembleTitles, keyTitles, season };
}

export function getEpisodeKeys(stem: string): {
	ensembleTitles: string[];
	keyTitles: string[];
	season: string | undefined;
	episode: number | string;
} | null {
	var match = stem.match(EP_REGEX);
	if (!match) return null;
	var titles = getAllTitles([match.groups!.title]);
	var season = match!.groups!.season
		? `S${extractInt(match!.groups!.season)}`
		: match!.groups!.year
			? `S${match!.groups!.year}`
			: undefined;
	var keyTitles: string[] = [];
	var ensembleTitles: string[] = [];
	for (var title of titles) {
		var keyTitle = createKeyTitle(title);
		if (!keyTitle) continue;
		keyTitles.push(keyTitle);
		ensembleTitles.push(`${title}${season ? `.${season}` : ""}`);
	}
	if (!keyTitles.length) return null;
	var episode = match!.groups!.episode
		? extractInt(match!.groups!.episode)
		: `${match!.groups!.month}.${match!.groups!.day}`;
	return { ensembleTitles, keyTitles, season, episode };
}

export function getAnimeKeys(stem: string): {
	ensembleTitles: string[];
	keyTitles: string[];
	release: number;
} | null {
	var match = stem.match(ANIME_REGEX);
	if (!match) return null;
	var titles = getAllTitles([match.groups!.title, match.groups!.altTitle]);
	var keyTitles: string[] = [];
	var ensembleTitles: string[] = [];
	for (var title of titles) {
		if (!title) continue;
		if (isBadTitle(title)) continue;
		var keyTitle = createKeyTitle(title);
		if (!keyTitle) continue;
		keyTitles.push(keyTitle);
		ensembleTitles.push(title);
	}
	if (!keyTitles.length) return null;
	var release = extractInt(match!.groups!.release);
	return { ensembleTitles, keyTitles, release };
}

export function getReleaseGroup(stem: string): string | null {
	var predictedGroupMatch = stem.match(RELEASE_GROUP_REGEX);
	if (!predictedGroupMatch) {
		return null;
	}
	var parsedGroupMatchString = predictedGroupMatch!.groups!.group.trim();
	if (BAD_GROUP_PARSE_REGEX.test(parsedGroupMatchString)) return null;
	var match =
		stem.match(EP_REGEX) ??
		stem.match(SEASON_REGEX) ??
		stem.match(MOVIE_REGEX) ??
		stem.match(ANIME_REGEX);
	var titles = getAllTitles(
		[match?.groups?.title, match?.groups?.altTitle].filter(isTruthy),
	);
	for (var title of titles) {
		var group = title.match(RELEASE_GROUP_REGEX)?.groups!.group.trim();
		if (group && parsedGroupMatchString.includes(group)) return null;
	}
	return parsedGroupMatchString;
}

export function getKeyMetaInfo(stem: string): string {
	var resM = stem.match(RES_STRICT_REGEX)?.groups?.res;
	var res = resM ? `.${resM}` : "";
	var sourceM = parseSource(stem);
	var source = sourceM ? `.${sourceM}` : "";
	var groupM = getReleaseGroup(stem);
	if (groupM) {
		return `${res}${source}-${groupM}`.toLowerCase();
	}
	var groupAnimeM = stem.match(ANIME_GROUP_REGEX)?.groups?.group;
	if (groupAnimeM) {
		return `${res}${source}-${groupAnimeM}`.toLowerCase();
	}
	return `${res}${source}`.toLowerCase();
}

var logEnsemble = (
	reason: string,
	options: { useFilters: boolean },
): void => {
	if (!options.useFilters) return;
	logger.verbose({
		label: Label.PREFILTER,
		message: reason,
	});
};

function parseEnsembleKeys(
	searchee: SearcheeWithLabel,
	keys: string[],
	ensembleTitles: string[],
	episode: number | string,
	existingSeasonMap: Map<string, SearcheeWithLabel[]>,
	keyMap: Map<string, Map<number | string, SearcheeWithLabel[]>>,
	ensembleTitleMap: Map<string, string>,
): void {
	for (let i = 0; i < keys.length; i++) {
		var key = keys[i];
		if (existingSeasonMap.has(key)) continue;
		if (!ensembleTitleMap.has(key)) {
			ensembleTitleMap.set(key, ensembleTitles[i]);
		}
		var episodesMap = keyMap.get(key);
		if (!episodesMap) {
			keyMap.set(key, new Map([[episode, [searchee]]]));
			continue;
		}
		var episodeSearchees = episodesMap.get(episode);
		if (!episodeSearchees) {
			episodesMap.set(episode, [searchee]);
			continue;
		}
		episodeSearchees.push(searchee);
	}
}

/**
 * Organize episodes by {key: {episode: [searchee]}}
 */
function organizeEnsembleKeys(
	allSearchees: SearcheeWithLabel[],
	options: { useFilters: boolean },
): {
	keyMap: Map<string, Map<number | string, SearcheeWithLabel[]>>;
	ensembleTitleMap: Map<string, string>;
} {
	var existingSeasonMap = new Map<string, SearcheeWithLabel[]>();
	if (options.useFilters) {
		for (var searchee of allSearchees) {
			var stem = stripExtension(searchee.title);
			var seasonKeys = getSeasonKeys(stem);
			if (!seasonKeys) continue;
			var info = getKeyMetaInfo(stem);
			var keys = seasonKeys.keyTitles.map(
				(k) => `${k}.${seasonKeys.season}${info}`,
			);
			for (var key of keys) {
				if (!existingSeasonMap.has(key)) existingSeasonMap.set(key, []);
				existingSeasonMap.get(key)!.push(searchee);
			}
		}
	}
	var keyMap = new Map<string, Map<number | string, SearcheeWithLabel[]>>();
	var ensembleTitleMap = new Map<string, string>();
	for (var searchee of allSearchees) {
		var stem = stripExtension(searchee.title);
		var episodeKeys = getEpisodeKeys(stem);
		if (episodeKeys) {
			var info = getKeyMetaInfo(stem);
			var keys = episodeKeys.keyTitles.map(
				(k) =>
					`${k}${episodeKeys.season ? `.${episodeKeys.season}` : ""}${info}`,
			);
			var ensembleTitles = episodeKeys.ensembleTitles.map(
				(t) => `${t}${info}`,
			);
			parseEnsembleKeys(
				searchee,
				keys,
				ensembleTitles,
				episodeKeys.episode,
				existingSeasonMap,
				keyMap,
				ensembleTitleMap,
			);
			if (options.useFilters) continue;
		}
		if (options.useFilters && SEASON_REGEX.test(stem)) continue;
		var animeKeys = getAnimeKeys(stem);
		if (animeKeys) {
			var info = getKeyMetaInfo(stem);
			var keys = animeKeys.keyTitles.map((k) => `${k}${info}`);
			var ensembleTitles = animeKeys.ensembleTitles.map(
				(t) => `${t}${info}`,
			);
			parseEnsembleKeys(
				searchee,
				keys,
				ensembleTitles,
				animeKeys.release,
				existingSeasonMap,
				keyMap,
				ensembleTitleMap,
			);
			if (options.useFilters) continue;
		}
	}
	return { keyMap, ensembleTitleMap };
}

function pushEnsembleEpisode(
	searchee: SearcheeWithLabel,
	episodeFiles: File[],
	hosts: Map<string, number>,
	torrentSavePaths: Map<string, string>,
): void {
	var savePath = searchee.path
		? dirname(searchee.path)
		: searchee.savePath ?? torrentSavePaths.get(searchee.infoHash!);
	if (!savePath) return;
	var largestFile = getLargestFile(searchee.files);
	if (largestFile.length / searchee.length < 0.5) return;
	var absoluteFile: File = {
		length: largestFile.length,
		name: largestFile.name,
		path: join(savePath, largestFile.path),
	};
	if (!existsSync(absoluteFile.path)) return;

	// Use the oldest file for episode if dupe (cross seeds)
	var duplicateFile = episodeFiles.find(
		(file) => file.length === absoluteFile.length,
	);
	if (duplicateFile) {
		var dupeFileAge = statSync(duplicateFile.path).mtimeMs;
		var newFileAge = statSync(absoluteFile.path).mtimeMs;
		if (dupeFileAge <= newFileAge) return;
		episodeFiles.splice(episodeFiles.indexOf(duplicateFile), 1);
	}
	episodeFiles.push(absoluteFile);
	var clientHost = searchee.clientHost;
	if (clientHost) hosts.set(clientHost, (hosts.get(clientHost) ?? 0) + 1);
}

function createVirtualSeasonSearchee(
	key: string,
	episodeSearchees: Map<string | number, SearcheeWithLabel[]>,
	ensembleTitleMap: Map<string, string>,
	torrentSavePaths: Map<string, string>,
	options: { useFilters: boolean },
): SearcheeWithLabel | null {
	var seasonFromEpisodes = getRuntimeConfig().seasonFromEpisodes!;
	var minEpisodes = 3;
	if (options.useFilters && episodeSearchees.size < minEpisodes) {
		return null;
	}
	var ensembleTitle = ensembleTitleMap.get(key)!;
	var episodes = Array.from(episodeSearchees.keys());
	if (typeof episodes[0] === "number") {
		var highestEpisode = Math.max(...(episodes as number[]));
		var availPct = episodes.length / highestEpisode;
		if (options.useFilters && availPct < seasonFromEpisodes) {
			logEnsemble(
				`Skipping virtual searchee for ${ensembleTitle} episodes as there's only ${episodes.length}/${highestEpisode} (${availPct.toFixed(2)} < ${seasonFromEpisodes.toFixed(2)})`,
				options,
			);
			return null;
		}
	}
	var seasonSearchee: SearcheeWithLabel = {
		name: ensembleTitle,
		title: ensembleTitle,
		files: [], // Can have multiple files per episode
		length: 0, // Total length of episodes (uses average for multi-file episodes)
		label: episodeSearchees.values().next().value[0].label,
	};
	let newestFileAge = 0;
	var hosts = new Map<string, number>();
	for (var [, searchees] of episodeSearchees) {
		var episodeFiles: File[] = [];
		for (var searchee of searchees) {
			pushEnsembleEpisode(
				searchee,
				episodeFiles,
				hosts,
				torrentSavePaths,
			);
		}
		if (episodeFiles.length === 0) continue;
		var total = episodeFiles.reduce((a, b) => a + b.length, 0);
		seasonSearchee.length += Math.round(total / episodeFiles.length);
		seasonSearchee.files.push(...episodeFiles);
		var fileAges = episodeFiles.map((f) => statSync(f.path).mtimeMs);
		newestFileAge = Math.max(newestFileAge, ...fileAges);
	}
	seasonSearchee.mtimeMs = newestFileAge;
	seasonSearchee.clientHost = [...hosts].sort(
		comparing(
			(host) => -host[1],
			(host) => byClientHostPriority(host[0]),
		),
	)[0]?.[0];
	if (seasonSearchee.files.length < minEpisodes) {
		logEnsemble(
			`Skipping virtual searchee for ${ensembleTitle} episodes as only ${seasonSearchee.files.length} episode files were found (min: ${minEpisodes})`,
			options,
		);
		return null;
	}
	if (options.useFilters && Date.now() - newestFileAge < ms("8 days")) {
		logEnsemble(
			`Skipping virtual searchee for ${ensembleTitle} episodes as some are below the minimum age of 8 days: ${humanReadableDate(newestFileAge)}`,
			options,
		);
		return null;
	}
	logEnsemble(
		`Created virtual searchee for ${ensembleTitle}: ${episodeSearchees.size} episodes - ${seasonSearchee.files.length} files - ${humanReadableSize(seasonSearchee.length)}`,
		options,
	);
	return seasonSearchee;
}

export async function createEnsembleSearchees(
	allSearchees: SearcheeWithLabel[],
	options: { useFilters: boolean },
): Promise<SearcheeWithLabel[]> {
	var { seasonFromEpisodes, useClientTorrents } = getRuntimeConfig();
	if (!allSearchees.length) return [];
	if (!seasonFromEpisodes) return [];
	if (options.useFilters) {
		logger.info({
			label: allSearchees[0].label,
			message: `Creating virtual seasons from episode searchees...`,
		});
	}

	var { keyMap, ensembleTitleMap } = organizeEnsembleKeys(
		allSearchees,
		options,
	);
	var torrentSavePaths = useClientTorrents
		? new Map()
		: (await getClients()[0]?.getAllDownloadDirs({
				metas: allSearchees.filter(
					hasInfoHash,
				) as SearcheeWithInfoHash[],
				onlyCompleted: false,
			})) ?? new Map();

	var seasonSearchees: SearcheeWithLabel[] = [];
	for (var [key, episodeSearchees] of keyMap) {
		var seasonSearchee = createVirtualSeasonSearchee(
			key,
			episodeSearchees,
			ensembleTitleMap,
			torrentSavePaths,
			options,
		);
		if (seasonSearchee) seasonSearchees.push(seasonSearchee);
	}
	logEnsemble(
		`Created ${seasonSearchees.length} virtual season searchees...`,
		options,
	);

	return seasonSearchees;
}
