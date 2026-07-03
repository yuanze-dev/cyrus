import type { FeishuEventEnvelope, FeishuWebhookEvent } from "../src/types.js";

export const BOT_OPEN_ID = "ou_bot";
export const USER_OPEN_ID = "ou_user";

/** A group @mention of the bot. */
export const testMentionEnvelope: FeishuEventEnvelope = {
	schema: "2.0",
	header: {
		event_id: "evt_mention_1",
		event_type: "im.message.receive_v1",
		create_time: "1700000000000",
		token: "verif-token",
		app_id: "cli_app",
		tenant_key: "tenant_1",
	},
	event: {
		sender: {
			sender_id: { open_id: USER_OPEN_ID },
			sender_type: "user",
			tenant_key: "tenant_1",
		},
		message: {
			message_id: "om_msg1",
			create_time: "1700000000000",
			chat_id: "oc_chat1",
			chat_type: "group",
			message_type: "text",
			content: JSON.stringify({ text: "@_user_1 please fix the login bug" }),
			mentions: [
				{ key: "@_user_1", id: { open_id: BOT_OPEN_ID }, name: "Cyrus" },
			],
		},
	},
};

/** A threaded plain follow-up (no @mention) inside an existing thread. */
export const testThreadedMessageEnvelope: FeishuEventEnvelope = {
	schema: "2.0",
	header: {
		event_id: "evt_msg_1",
		event_type: "im.message.receive_v1",
		create_time: "1700000001000",
		token: "verif-token",
		app_id: "cli_app",
		tenant_key: "tenant_1",
	},
	event: {
		sender: {
			sender_id: { open_id: USER_OPEN_ID },
			sender_type: "user",
			tenant_key: "tenant_1",
		},
		message: {
			message_id: "om_msg2",
			root_id: "om_msg1",
			thread_id: "omt_thread1",
			create_time: "1700000001000",
			chat_id: "oc_chat1",
			chat_type: "group",
			message_type: "text",
			content: JSON.stringify({ text: "also add a logout button" }),
		},
	},
};

/** A top-level plain group message (no @mention, no thread). */
export const testPlainGroupEnvelope: FeishuEventEnvelope = {
	schema: "2.0",
	header: {
		event_id: "evt_msg_plain",
		event_type: "im.message.receive_v1",
		create_time: "1700000002000",
		token: "verif-token",
		app_id: "cli_app",
		tenant_key: "tenant_1",
	},
	event: {
		sender: {
			sender_id: { open_id: USER_OPEN_ID },
			sender_type: "user",
			tenant_key: "tenant_1",
		},
		message: {
			message_id: "om_msg3",
			create_time: "1700000002000",
			chat_id: "oc_chat1",
			chat_type: "group",
			message_type: "text",
			content: JSON.stringify({ text: "just chatting" }),
		},
	},
};

/** A direct (p2p) message to the bot. */
export const testP2pEnvelope: FeishuEventEnvelope = {
	schema: "2.0",
	header: {
		event_id: "evt_p2p_1",
		event_type: "im.message.receive_v1",
		create_time: "1700000003000",
		token: "verif-token",
		app_id: "cli_app",
		tenant_key: "tenant_1",
	},
	event: {
		sender: {
			sender_id: { open_id: USER_OPEN_ID },
			sender_type: "user",
			tenant_key: "tenant_1",
		},
		message: {
			message_id: "om_msg4",
			create_time: "1700000003000",
			chat_id: "oc_dm1",
			chat_type: "p2p",
			message_type: "text",
			content: JSON.stringify({ text: "hello Cyrus" }),
		},
	},
};

export const testUrlVerificationEnvelope: FeishuEventEnvelope = {
	type: "url_verification",
	challenge: "challenge-abc-123",
	token: "verif-token",
};

/** A normalized webhook event for translator tests. */
export const testMentionWebhookEvent: FeishuWebhookEvent = {
	eventType: "mention",
	eventId: "evt_mention_1",
	tenantKey: "tenant_1",
	payload: {
		type: "mention",
		user: USER_OPEN_ID,
		text: "please fix the login bug",
		rawContent: JSON.stringify({ text: "@_user_1 please fix the login bug" }),
		messageType: "text",
		messageId: "om_msg1",
		chatId: "oc_chat1",
		chatType: "group",
		createTime: "1700000000000",
		mentions: [
			{ key: "@_user_1", id: { open_id: BOT_OPEN_ID }, name: "Cyrus" },
		],
	},
};

export const testMessageWebhookEvent: FeishuWebhookEvent = {
	eventType: "message",
	eventId: "evt_msg_1",
	tenantKey: "tenant_1",
	payload: {
		type: "message",
		user: USER_OPEN_ID,
		text: "also add a logout button",
		rawContent: JSON.stringify({ text: "also add a logout button" }),
		messageType: "text",
		messageId: "om_msg2",
		rootId: "om_msg1",
		threadId: "omt_thread1",
		chatId: "oc_chat1",
		chatType: "group",
		createTime: "1700000001000",
	},
};
