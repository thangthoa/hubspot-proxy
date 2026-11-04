/**
 * Field policy for the partner API.
 *
 * PLACEHOLDER VALUES — confirm the exact field lists with Namy before go-live.
 * Every field a partner can see or change must be listed here explicitly;
 * anything not listed is invisible (read) or rejected (write).
 */

/** HubSpot contact properties returned to partners. */
export const READ_PROPERTIES = [
  'email',
  'firstname',
  'lastname',
  'phone',
  'mobilephone',
  'company',
  'jobtitle',
  'city',
  'lifecyclestage',
  'createdate',
  'lastmodifieddate',
] as const;

/** HubSpot contact properties partners may set on create and update. */
export const WRITE_PROPERTIES = [
  'email',
  'firstname',
  'lastname',
  'phone',
  'mobilephone',
  'company',
  'jobtitle',
  'city',
] as const;

/**
 * Properties a partner may never set to an empty value.
 * Blocks "deleting" a contact's key data through an update.
 */
export const NON_CLEARABLE_PROPERTIES = ['email', 'firstname', 'lastname'] as const;

/** Properties every new contact must carry. */
export const CREATE_REQUIRED_PROPERTIES = ['email'] as const;

export const LIMITS = {
  listDefault: 20,
  listMax: 100,
  /** HubSpot's own ceiling for batch/create. */
  batchMax: 100,
  valueMaxLength: 1000,
} as const;

export const SCOPES = {
  read: 'namy-api/contacts.read',
  write: 'namy-api/contacts.write',
} as const;
