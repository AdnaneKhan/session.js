import type { Profile } from "@/profile";
import type {
	MediaSavedNotification,
	Message,
	MessageDeleted,
	MessageReadEvent,
	MessageTypingIndicator,
	ScreenshotTakenNotification,
	MessageRequestResponse,
	CallMessage,
	ClosedGroupUpdate,
	ClosedGroupConfig,
	ReactionMessage,
	SyncMessage,
} from "../messages";

export type EventCallbackSignatures = {
	message: (message: Message) => void;
	syncMessage: (message: SyncMessage) => void;
	syncDisplayName: (displayName: string) => void;
	syncAvatar: (avatar: Profile["avatar"]) => void;
	messageDeleted: (message: MessageDeleted) => void;
	messageRead: (message: MessageReadEvent) => void;
	messageTypingIndicator: (indicator: MessageTypingIndicator) => void;
	screenshotTaken: (notification: ScreenshotTakenNotification) => void;
	mediaSaved: (notification: MediaSavedNotification) => void;
	messageRequestApproved: (message: MessageRequestResponse) => void;
	call: (call: CallMessage) => void;
	/** A legacy closed-group control message (NEW / NAME_CHANGE / MEMBERS_* / MEMBER_LEFT / ENCRYPTION_KEY_PAIR). */
	groupUpdate: (update: ClosedGroupUpdate) => void;
	/** Closed groups carried in a legacy multi-device ConfigurationMessage sync. */
	syncClosedGroups: (groups: ClosedGroupConfig[]) => void;
	reactionAdded: (reaction: ReactionMessage) => void;
	reactionRemoved: (reaction: ReactionMessage) => void;
};
export type EventName = keyof EventCallbackSignatures;
export type EventCallback<E extends EventName> = EventCallbackSignatures[E];
