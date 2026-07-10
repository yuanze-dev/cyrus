import type { AgentActivityContent } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ActivityObserver,
	AgentSessionManager,
} from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * The passive activity-observer tap (IN-42 §Q4) must receive a copy of every
 * activity posted to a session's primary sink, and must never be able to disturb
 * that primary path — a throwing/rejecting observer is swallowed.
 */
describe("AgentSessionManager - activity observer tap", () => {
	let manager: AgentSessionManager;
	let sink: IActivitySink;
	const sessionId = "obs-session";
	const issueId = "obs-issue";

	beforeEach(() => {
		sink = {
			id: "ws",
			postActivity: vi.fn().mockResolvedValue({ activityId: "a1" }),
			createAgentSession: vi.fn().mockResolvedValue("ext-1"),
		};
		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "IN-49",
				title: "Backflow",
				description: "",
				branchName: "b",
			},
			{ path: "/tmp/ws", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, sink);
	});

	it("mirrors posted activities to the registered observer", async () => {
		const seen: Array<{ sessionId: string; content: AgentActivityContent }> =
			[];
		const observer: ActivityObserver = {
			onActivity: (sid, content) => {
				seen.push({ sessionId: sid, content });
			},
		};
		manager.setActivityObserver(observer);

		await manager.createResponseActivity(sessionId, "final answer");

		expect(seen).toHaveLength(1);
		expect(seen[0].sessionId).toBe(sessionId);
		expect(seen[0].content).toMatchObject({
			type: "response",
			body: "final answer",
		});
		// Primary sink still got the post.
		expect(sink.postActivity).toHaveBeenCalledTimes(1);
	});

	it("does not invoke the observer once cleared", async () => {
		const onActivity = vi.fn();
		manager.setActivityObserver({ onActivity });
		manager.setActivityObserver(undefined);

		await manager.createResponseActivity(sessionId, "answer");

		expect(onActivity).not.toHaveBeenCalled();
		expect(sink.postActivity).toHaveBeenCalledTimes(1);
	});

	it("swallows an observer that throws — primary post is unaffected", async () => {
		manager.setActivityObserver({
			onActivity: () => {
				throw new Error("observer boom");
			},
		});

		await expect(
			manager.createResponseActivity(sessionId, "answer"),
		).resolves.toBeUndefined();
		expect(sink.postActivity).toHaveBeenCalledTimes(1);
	});

	it("swallows an observer that rejects asynchronously", async () => {
		manager.setActivityObserver({
			onActivity: () => Promise.reject(new Error("async boom")),
		});

		await expect(
			manager.createResponseActivity(sessionId, "answer"),
		).resolves.toBeUndefined();
		expect(sink.postActivity).toHaveBeenCalledTimes(1);
	});
});
