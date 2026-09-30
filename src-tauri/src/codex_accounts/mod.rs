//! Multiple official ChatGPT accounts for Codex (plan §2 M4, D8 option (d)).
//!
//! An account is a ChatGPT identity (`chatgpt_user_id`, `chatgpt_account_id`)
//! whose `auth.json` is stored exactly once, in the [`vault`]. Official lines
//! stay `providers` rows that only pin an account (`meta.officialAccount`);
//! no token ever reaches the database, IPC, exports, deep links or logs.
//! Everything here sits behind the `official_accounts` capability.

pub(crate) mod identity;
pub(crate) mod vault;
