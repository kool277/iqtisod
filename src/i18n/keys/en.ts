/** Strings for per-person keys (2.0): the founder-key check at sign-in, the upgrade offer, and the key details. */
export const keysEn = {
  trust: {
    title: 'Compare the founder key',
    body: 'This browser has not opened this vault before. Compare its founder key with your admin, in person or by phone, before you go on. If it is different, this is not your vault: cancel.',
    label: 'Founder key',
    confirm: 'It matches, continue',
    cancel: 'Cancel',
  },
  notice: {
    founderTitle: 'Write down your founder key',
    founderBody: 'You founded this vault. Anyone who signs in to it in a new browser is asked to compare this key with you, so keep it where you can read it out.',
    joinedTitle: 'Compare the founder key',
    joinedBody: 'This browser has not opened this vault before. Compare its founder key with your admin, and tell them at once if it is different.',
    copy: 'Copy',
    copied: 'Copied',
    done: 'Done',
  },
  blocked: {
    help: 'The vault can still be saved as a file, encrypted exactly as this browser stores it, so nothing is lost while your admin looks into this. It opens with a member’s password in the recovery tool. Open invite codes are left out of it.',
    download: 'Download this vault as a file',
    downloaded: 'Downloaded. Keep the file until your admin has looked into this.',
  },
  restore: {
    backupPassword: 'Your password in this backup',
    removals: 'People removed since then. They are suspended again, and everyone else gets a new household key:',
    noRemovals: 'Nobody was removed since then.',
    unknown: 'This browser cannot tell who was removed since then, so they may be able to open this copy. Suspend or delete them again once it is restored.',
    confirm: 'Restore this older copy',
    audit: 'Restoring it is written to the audit log.',
  },
  rollback: {
    open: 'Open this older copy anyway',
    confirm: 'Open the older copy? People removed since then may be able to sign in to it, and changes made since then are not in it. Opening it is written to the audit log.',
  },
  upgrade: {
    title: 'Upgrade to per-person keys',
    body: 'Each person gets their own keys, and the list of people is signed by an admin. You become this vault’s founder. Everyone else needs a new invite code from you: their old passwords stop working.',
    people: 'People who will need a new invite code: {count}',
    keep: 'Records, history and private safes stay as they are. The vault as it is now stays in this browser and can be downloaded from the Backup page.',
    password: 'Your password',
    confirm: 'Upgrade now',
    later: 'Not now',
    working: 'Upgrading…',
    done: 'Upgraded. Give each person a new invite code from the People page.',
  },
  account: {
    title: 'Vault keys',
    founder: 'Founder key',
    you: 'You are this vault’s founder.',
    help: 'Anyone who signs in to this vault in a new browser compares this key with an admin.',
  },
}

export type KeysMessages = typeof keysEn
