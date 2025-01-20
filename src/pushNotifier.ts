import {
	ActionResult,
	InjectionResult,
	PROGRAM_NAME,
	SaveResult,
	USER_AGENT,
} from "./constants.js";
import { getPartialSizeRatio, ResultAssessment } from "./decide.js";
import { logger } from "./logger.js";
import { getRuntimeConfig } from "./runtimeConfig.js";
import { getSearcheeSource, SearcheeWithLabel } from "./searchee.js";
import { formatAsList } from "./utils.js";

export let pushNotifier: PushNotifier;

enum Event {
	TEST = "TEST",
	RESULTS = "RESULTS",
}

type TrackerName = string;

interface PushNotification {
	title?: string;
	body: string;
	extra?: Record<string, unknown>;
}

export class PushNotifier {
	urls: string[];

	constructor(urls: string[]) {
		this.urls = urls;
	}

	async notify({
		title = PROGRAM_NAME,
		body,
		...rest
	}: PushNotification): Promise<void[]> {
		return Promise.all(
			this.urls.map(async (url) => {
				try {
					var response = await fetch(url, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"User-Agent": USER_AGENT,
						},
						body: JSON.stringify({ title, body, ...rest }),
					});

					if (!response.ok) {
						var responseText = await response.clone().text();
						logger.error(
							`${url} rejected push notification: ${response.status} ${response.statusText}`,
						);
						logger.debug(
							`${url}: ${responseText.slice(0, 100)}${
								responseText.length > 100 ? "..." : ""
							}"`,
						);
					}
				} catch (e) {
					logger.error(
						`${url} failed to send push notification: ${e.message}`,
					);
					logger.debug(e);
				}
			}),
		);
	}
}

export function sendResultsNotification(
	searchee: SearcheeWithLabel,
	results: [ResultAssessment, TrackerName, ActionResult][],
) {
	var { autoResumeMaxDownload } = getRuntimeConfig();
	var source = searchee.label;
	var searcheeCategory = searchee.category ?? null;
	var searcheeTags = searchee.tags ?? null;
	var searcheeTrackers = searchee.trackers ?? null;
	var searcheeLength = searchee.length;
	var searcheeInfoHash = searchee.infoHash ?? null;
	var searcheeClientHost = searchee.clientHost ?? null;
	var searcheePath = searchee.path ?? null;
	var searcheeSource = getSearcheeSource(searchee);

	var notableSuccesses = results.filter(
		([, , actionResult]) =>
			actionResult === InjectionResult.SUCCESS ||
			actionResult === SaveResult.SAVED,
	);
	if (notableSuccesses.length) {
		var name = notableSuccesses[0][0].metafile!.name;
		var numTrackers = notableSuccesses.length;
		var infoHashes = notableSuccesses.map(
			([{ metafile }]) => metafile!.infoHash,
		);
		var trackers = notableSuccesses.map(([, tracker]) => tracker);
		var trackersListStr = formatAsList(trackers, { sort: true });
		var paused = notableSuccesses.some(
			([{ metafile }]) =>
				(1 - getPartialSizeRatio(metafile!, searchee)) *
					metafile!.length >
				autoResumeMaxDownload,
		);
		var injected = notableSuccesses.some(
			([, , actionResult]) => actionResult === InjectionResult.SUCCESS,
		);
		var performedAction = injected
			? `Injected${paused ? " (paused)" : ""}`
			: "Saved";
		var decisions = notableSuccesses.map(([{ decision }]) => decision);

		pushNotifier.notify({
			body: `${source}: ${performedAction} ${name} on ${numTrackers} tracker${numTrackers !== 1 ? "s" : ""} by ${formatAsList(decisions, { sort: true })} from ${searcheeSource}: ${trackersListStr}`,
			extra: {
				event: Event.RESULTS,
				name,
				infoHashes,
				trackers,
				source,
				result: injected ? InjectionResult.SUCCESS : SaveResult.SAVED,
				paused,
				decisions,
				searchee: {
					category: searcheeCategory,
					tags: searcheeTags,
					trackers: searcheeTrackers,
					length: searcheeLength,
					clientHost: searcheeClientHost,
					infoHash: searcheeInfoHash,
					path: searcheePath,
					source: searcheeSource,
				},
			},
		});
	}

	var failures = results.filter(
		([, , actionResult]) => actionResult === InjectionResult.FAILURE,
	);
	if (failures.length) {
		var name = failures[0][0].metafile!.name;
		var numTrackers = failures.length;
		var infoHashes = failures.map(([{ metafile }]) => metafile!.infoHash);
		var trackers = failures.map(([, tracker]) => tracker);
		var trackersListStr = formatAsList(trackers, { sort: true });
		var decisions = failures.map(([{ decision }]) => decision);

		pushNotifier.notify({
			body: `${source}: Failed to inject ${name} on ${numTrackers} tracker${numTrackers !== 1 ? "s" : ""} by ${formatAsList(decisions, { sort: true })} from ${searcheeSource}: ${trackersListStr}`,
			extra: {
				event: Event.RESULTS,
				name,
				infoHashes,
				trackers,
				source,
				result: failures[0][2],
				paused: false,
				decisions,
				searchee: {
					category: searcheeCategory,
					tags: searcheeTags,
					trackers: searcheeTrackers,
					length: searcheeLength,
					clientHost: searcheeClientHost,
					infoHash: searcheeInfoHash,
					path: searcheePath,
					source: searcheeSource,
				},
			},
		});
	}
}

export function initializePushNotifier(): void {
	var { notificationWebhookUrls } = getRuntimeConfig();
	pushNotifier = new PushNotifier(notificationWebhookUrls);
}

export async function sendTestNotification(): Promise<void> {
	await pushNotifier.notify({ body: "Test", extra: { event: Event.TEST } });
	logger.info("Sent test notification");
}
