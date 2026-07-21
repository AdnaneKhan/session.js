# Managing members

| Action | Who may | Method | Wire |
|---|---|---|---|
| Add | any member | `sendAddMembers` | `MEMBERS_ADDED` to the swarm + `NEW` invite DM to each newcomer; admins keypair-push to newcomers |
| Remove | **admins only** | `sendRemoveMembers` | `MEMBERS_REMOVED` to the swarm **+ key rotation** |
| Leave | any member | `sendLeave` | `MEMBER_LEFT` to the swarm |
| Rename | any member | `sendRename` | `NAME_CHANGE` to the swarm |

## Add members

```ts
await groups.sendAddMembers(group.publicKey, [newMemberId]);
```

Sends `MEMBERS_ADDED` to the group swarm and a `NEW` invite (with the latest
keypair) to each newcomer, who join automatically. When an **admin** observes
new members, it additionally pushes the latest keypair to them directly (a
guard against the remove/re-add race). Re-adding a member who previously left
clears their "zombie" flag.

## Remove members (admin-only, rotates the key)

```ts
await groups.sendRemoveMembers(group.publicKey, [memberId]);
```

Only admins may remove. After `MEMBERS_REMOVED` lands, the removing admin
**rotates** the group encryption keypair: a fresh x25519 pair is wrapped to
each *remaining* member (sealed to their identity key) and distributed to the
group swarm. The removed member is deleted from everyone's view.

```ts
// Non-admins: throws NotAnAdminError.
// Removing the first admin: throws (admins can only leave).
// Removing yourself: throws — use sendLeave.
```

!!! Warning "Revocation is weak"
    Rotation stops the removed member from reading **future** messages, but
    they keep all historical private keys (decryptable until 14-day expiry /
    pre-rotation). See [Protocol & caveats](protocol.md).

## Leave

```ts
await groups.sendLeave(group.publicKey);
```

Sends `MEMBER_LEFT` and deletes the group locally.

- If a **non-admin** leaves, the others remove them from `members` and record a
  **zombie** (left-but-not-removed; an admin may later convert it to a removal,
  which rotates).
- If an **admin** leaves, the group is **disbanded for everyone** (each member
  deletes it) — there is no admin transfer in v1.

## Rename

```ts
await groups.sendRename(group.publicKey, "New name");
```

## Reading state

```ts
const group = groups.getGroup(group.publicKey);
group.members;  // current members (05…hex)
group.admins;   // admins
group.zombies;  // left-but-not-removed
group.active;   // false once we've left / been removed
```
