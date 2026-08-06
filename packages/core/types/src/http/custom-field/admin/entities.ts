/**
 * The types a custom field may declare. Mirrors the custom fields module's
 * `CustomFieldType` vocabulary, which itself mirrors DML.
 */
export type AdminCustomFieldType =
  | "text"
  | "number"
  | "float"
  | "boolean"
  | "date"
  | "dateTime"
  | "json"
  | "enum"

/**
 * One custom field definition, as configured on the custom fields module and
 * served to the admin dashboard so it can render inputs and displays at
 * runtime.
 */
export interface AdminCustomFieldDefinition {
  /**
   * The entity the field is attached to — for example `product`.
   */
  entity: string
  /**
   * The field's key. Unique per entity, sent verbatim under `custom_fields`
   * in write payloads.
   */
  key: string
  /**
   * The field's type.
   */
  type: AdminCustomFieldType
  /**
   * Whether a value is required when the entity is created. A configured
   * `default_value` satisfies the requirement.
   */
  required: boolean
  /**
   * Whether the field is writable only programmatically. A readonly field is
   * rejected in write payloads and rendered as plain text, never as an input.
   */
  readonly: boolean
  /**
   * Whether the field is retrievable only through the admin API.
   */
  restricted: boolean
  /**
   * The permitted values, for `enum` fields.
   */
  choices?: string[]
  /**
   * Inclusive lower bound — a number for `number`/`float`, an ISO string for
   * `date`/`dateTime`.
   */
  min?: number | string
  /**
   * Inclusive upper bound. Same shape as `min`.
   */
  max?: number | string
  /**
   * Display order, ascending, default 0, ties broken by key. Definitions are
   * already served in display order; the value is passed through for
   * config-editing UIs.
   */
  rank?: number
  /**
   * The value an omitted field takes on create.
   */
  default_value?: unknown
  /**
   * Display label. Falls back to a humanized key when unset.
   */
  label?: string
  /**
   * Display description.
   */
  description?: string
}
