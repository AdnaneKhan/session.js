# API reference

## `GroupManager`

```ts
new GroupManager(
	session: GroupSessionLike,          // a patched Session (boundary cast: session as never)
	options?: GroupManagerOptions,
	deps?: { storage?: StorageLike },    // default: InMemoryGroupStorage
)
```

### Lifecycle

| Method | Description |
|---|---|
| `init(): Promise<void>` | Load known groups from storage (idempotent). Call after construction. |
| `dispose(): Promise<void>` | Unsubscribe from the session, stop group pollers (idempotent). |
| `isInitialized(): boolean` / `isDisposed(): boolean` | State flags. |
| `ourId: string` | Our Session ID. |
| `now(): number` | Clock used for watermarks (injectable via `options.now`). |

### Group operations

| Method | Description |
|---|---|
| `createGroup({ name, members, expirationTimer? }): Promise<GroupState>` | Create + invite (you become the admin). |
| `sendMessage(groupPubKey, text?, { expireTimer? }): Promise<{ messageHash, timestamp }>` | Send a group chat message. |
| `sendAddMembers(groupPubKey, membersToAdd[]): Promise<void>` | Add members (any member). |
| `sendRemoveMembers(groupPubKey, membersToRemove[]): Promise<void>` | Remove members (admin-only; rotates the key). |
| `sendRename(groupPubKey, newName): Promise<void>` | Rename (any member). |
| `sendLeave(groupPubKey): Promise<void>` | Leave (deletes locally). |
| `syncGroupsToLinkedDevices(): Promise<void>` | Push active groups (latest keypair each) as a legacy config sync. |

### Queries

| Method | Description |
|---|---|
| `getGroups(): GroupState[]` | All known groups (incl. inactive). |
| `getActiveGroups(): GroupState[]` | Active groups only. |
| `getGroup(publicKey): GroupState \| undefined` | One group. |
| `getEncryptionKeyPairs(publicKey): Promise<GroupEncryptionKeypair[]>` | All keypairs (append order, newest last). |
| `getLatestEncryptionKeyPair(publicKey): Promise<GroupEncryptionKeypair \| undefined>` | The key used to send. |
| `storage: GroupStorage` / `keypairs: KeypairRegistry` | Typed persistence access. |

### Events

| Event | Payload |
|---|---|
| `groupCreated` | `GroupState` |
| `groupJoined` | `GroupState` |
| `groupChanged` | `GroupState` (name / members / keypair changed) |
| `groupRemoved` | `{ publicKey: string }` |
| `groupMessage` | `{ type: "group", groupId, from, id, text?, timestamp }` |
| `error` | `{ groupPubKey?, error }` |

## `GroupState`

```ts
{
	publicKey: string;          // 05… group address
	name: string;
	members: string[];          // 05…hex
	admins: string[];           // 05…hex
	zombies: string[];          // left-but-not-removed
	active: boolean;            // false once left / removed
	lastJoinedTimestamp: number;// join watermark (stale updates dropped)
	formationTimestamp: number;
	expirationTimer: number;    // deleteAfterSend seconds (0 = off)
}
```

## `GroupManagerOptions`

```ts
{
	now?: () => number;                 // injectable clock
	logger?: (level, msg, meta?) => void; // never receives key material
	isSenderApproved?: (from: string) => boolean; // NEW-invite gate (default: accept all)
}
```

## Errors

`GroupError` base with stable `code`s: `GroupNotFoundError`, `NotAMemberError`,
`NotAnAdminError`, `GroupTooLargeError`, `InvalidGroupError`,
`InvalidKeypairError`, `GroupInactiveError`, `StaleUpdateError`.

## Client core additions (used under the hood)

`Session`: `sendGroupMessage`, `sendClosedGroupUpdate`, `sendConfigurationMessage`,
`sealKeypairWrapper`, `openKeypairWrapper`, `addGroupPoller`, `removeGroupPoller`;
events `groupUpdate` and `syncClosedGroups`; `@session.js/client/crypto` export.
