import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type FeishuIssueBindingInput,
	FeishuIssueNotificationService,
	type FeishuThreadNotifier,
} from "../src/FeishuIssueNotificationService.js";

const BINDING: FeishuIssueBindingInput = {
	issueIdentifier: "IN-42",
	issueId: "uuid-42",
	issueTitle: "Ship the thing",
	issueUrl: "https://linear.app/acme/issue/IN-42/ship-the-thing",
	chatId: "oc_chat",
	openId: "ou_requester",
	userName: "Ada",
	rootMessageId: "om_root",
};

function makeService(notifier: FeishuThreadNotifier) {
	const onChange = vi.fn();
	let clock = 1_000;
	const service = new FeishuIssueNotificationService({
		notifier,
		onChange,
		now: () => clock,
	});
	return {
		service,
		onChange,
		advanceClock: (ms: number) => {
			clock += ms;
		},
	};
}

describe("FeishuIssueNotificationService", () => {
	let notifier: ReturnType<typeof vi.fn> & FeishuThreadNotifier;

	beforeEach(() => {
		notifier = vi.fn().mockResolvedValue(undefined) as never;
	});

	it("records a new binding and reports it via serialize + onChange", () => {
		const { service, onChange } = makeService(notifier);
		service.recordIssueBinding(BINDING);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(service.hasBinding("IN-42")).toBe(true);
		expect(service.serialize()).toEqual({
			"IN-42": {
				issueIdentifier: "IN-42",
				issueId: "uuid-42",
				issueTitle: "Ship the thing",
				issueUrl: "https://linear.app/acme/issue/IN-42/ship-the-thing",
				chatId: "oc_chat",
				openId: "ou_requester",
				userName: "Ada",
				rootMessageId: "om_root",
			},
		});
	});

	it("preserves source context and notifiedAt on re-record, backfilling metadata", async () => {
		const { service } = makeService(notifier);
		// First capture had no UUID/title/url.
		service.recordIssueBinding({
			issueIdentifier: "IN-42",
			chatId: "oc_chat",
			openId: "ou_requester",
			userName: "Ada",
			rootMessageId: "om_root",
		});
		await service.notifyIssueCompleted({ issueIdentifier: "IN-42" });
		const notifiedAt = service.getBinding("IN-42")?.notifiedAt;
		expect(notifiedAt).toBeDefined();

		// A later save_issue update supplies the UUID/title/url and a different
		// (wrong) requester must NOT override the original source context.
		service.recordIssueBinding({
			issueIdentifier: "IN-42",
			issueId: "uuid-42",
			issueTitle: "Ship the thing",
			issueUrl: "https://linear.app/acme/issue/IN-42/ship-the-thing",
			chatId: "oc_other",
			openId: "ou_other",
			rootMessageId: "om_other",
		});

		const binding = service.getBinding("IN-42");
		expect(binding).toMatchObject({
			issueId: "uuid-42",
			issueTitle: "Ship the thing",
			issueUrl: "https://linear.app/acme/issue/IN-42/ship-the-thing",
			// Source context and notification stamp are untouched.
			chatId: "oc_chat",
			openId: "ou_requester",
			rootMessageId: "om_root",
			notifiedAt,
		});
	});

	it("does nothing when the completed issue has no binding", async () => {
		const { service } = makeService(notifier);
		const notified = await service.notifyIssueCompleted({
			issueIdentifier: "OTHER-1",
			issueId: "uuid-other",
		});
		expect(notified).toBe(false);
		expect(notifier).not.toHaveBeenCalled();
	});

	it("posts an in-thread notice with title + URL + requester name", async () => {
		const { service, onChange } = makeService(notifier);
		service.recordIssueBinding(BINDING);
		onChange.mockClear();

		const notified = await service.notifyIssueCompleted({
			issueIdentifier: "IN-42",
			issueId: "uuid-42",
			title: "Ship the thing",
			url: "https://linear.app/acme/issue/IN-42/ship-the-thing",
		});

		expect(notified).toBe(true);
		expect(notifier).toHaveBeenCalledTimes(1);
		const call = notifier.mock.calls[0][0];
		expect(call.rootMessageId).toBe("om_root");
		expect(call.chatId).toBe("oc_chat");
		expect(call.text).toContain("Ship the thing");
		expect(call.text).toContain(
			"https://linear.app/acme/issue/IN-42/ship-the-thing",
		);
		expect(call.text).toContain("Ada");
		// Stamped + persisted.
		expect(service.getBinding("IN-42")?.notifiedAt).toBe(1_000);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("is idempotent: a second completion event does not re-notify", async () => {
		const { service } = makeService(notifier);
		service.recordIssueBinding(BINDING);

		const first = await service.notifyIssueCompleted({
			issueIdentifier: "IN-42",
		});
		const second = await service.notifyIssueCompleted({
			issueIdentifier: "IN-42",
		});

		expect(first).toBe(true);
		expect(second).toBe(false);
		expect(notifier).toHaveBeenCalledTimes(1);
	});

	it("falls back to a UUID lookup when the identifier is not the key", async () => {
		const { service } = makeService(notifier);
		service.recordIssueBinding(BINDING);

		// Completion event arrives with an unrelated identifier but the same UUID.
		const notified = await service.notifyIssueCompleted({
			issueIdentifier: "STALE-9",
			issueId: "uuid-42",
		});
		expect(notified).toBe(true);
		expect(notifier).toHaveBeenCalledTimes(1);
	});

	it("uses the captured title/URL when the completion event omits them", async () => {
		const { service } = makeService(notifier);
		service.recordIssueBinding(BINDING);

		await service.notifyIssueCompleted({ issueIdentifier: "IN-42" });
		const text = notifier.mock.calls[0][0].text as string;
		expect(text).toContain("Ship the thing");
		expect(text).toContain(
			"https://linear.app/acme/issue/IN-42/ship-the-thing",
		);
	});

	it("does not mark as notified when delivery fails, allowing a retry", async () => {
		const failing = vi
			.fn()
			.mockRejectedValueOnce(new Error("feishu down"))
			.mockResolvedValueOnce(undefined) as never as FeishuThreadNotifier;
		const { service } = makeService(failing);
		service.recordIssueBinding(BINDING);

		await expect(
			service.notifyIssueCompleted({ issueIdentifier: "IN-42" }),
		).rejects.toThrow("feishu down");
		expect(service.getBinding("IN-42")?.notifiedAt).toBeUndefined();

		// A subsequent completion event succeeds.
		const retried = await service.notifyIssueCompleted({
			issueIdentifier: "IN-42",
		});
		expect(retried).toBe(true);
		expect(service.getBinding("IN-42")?.notifiedAt).toBeDefined();
	});

	it("round-trips bindings through serialize/restore", async () => {
		const { service } = makeService(notifier);
		service.recordIssueBinding(BINDING);
		await service.notifyIssueCompleted({ issueIdentifier: "IN-42" });
		const snapshot = service.serialize();

		const { service: restored } = makeService(notifier);
		restored.restore(snapshot);

		// Restored binding is already notified → no duplicate notice.
		const notified = await restored.notifyIssueCompleted({
			issueIdentifier: "IN-42",
		});
		expect(notified).toBe(false);
		expect(restored.serialize()).toEqual(snapshot);
	});

	it("restore(undefined) clears existing bindings", () => {
		const { service } = makeService(notifier);
		service.recordIssueBinding(BINDING);
		service.restore(undefined);
		expect(service.hasBinding("IN-42")).toBe(false);
	});

	it("posts a canceled notice via notifyIssueStateChange", async () => {
		const { service } = makeService(notifier);
		service.recordIssueBinding(BINDING);

		const notified = await service.notifyIssueStateChange({
			issueIdentifier: "IN-42",
			stateType: "canceled",
		});

		expect(notified).toBe(true);
		const text = notifier.mock.calls[0][0].text as string;
		expect(text).toContain("已取消");
		expect(text).toContain("Ship the thing");
	});

	it("stamps notifiedAt for canceled too, so it does not double-notify", async () => {
		const { service } = makeService(notifier);
		service.recordIssueBinding(BINDING);

		const first = await service.notifyIssueStateChange({
			issueIdentifier: "IN-42",
			stateType: "canceled",
		});
		const second = await service.notifyIssueStateChange({
			issueIdentifier: "IN-42",
			stateType: "canceled",
		});

		expect(first).toBe(true);
		expect(second).toBe(false);
		expect(notifier).toHaveBeenCalledTimes(1);
	});

	it("notifyIssueStateChange defaults to the completed message", async () => {
		const { service } = makeService(notifier);
		service.recordIssueBinding(BINDING);

		await service.notifyIssueStateChange({ issueIdentifier: "IN-42" });
		const text = notifier.mock.calls[0][0].text as string;
		expect(text).toContain("已完成");
	});
});
