/**
 * The types a custom field may declare. Each maps to a real column on the
 * owning entity's satellite table, which is what makes custom fields filterable
 * and sortable through `query.graph` rather than opaque JSON.
 *
 * Names and column types are taken from DML rather than invented, so a custom
 * field behaves exactly like a field declared on a model — `number` is an
 * `integer` here for the same reason `model.number()` is one. Diverging is how
 * the satellite ended up with a `numeric` column described by `integer`
 * metadata, whose values then came back as strings.
 *
 * Three DML types are deliberately absent:
 *
 * - `bigNumber` always brings a companion `raw_<field>` json column, so a
 *   single definition would own two physical columns and the planner's orphan
 *   detection would flag the second.
 * - `array` and `id`/`serial` are not meaningful as user-declared values on a
 *   1:1 satellite.
 */
export const CustomFieldType = {
  text: "text",
  number: "number",
  float: "float",
  boolean: "boolean",
  dateTime: "dateTime",
  json: "json",
  enum: "enum",
} as const

export type CustomFieldTypeValue =
  (typeof CustomFieldType)[keyof typeof CustomFieldType]

/**
 * One field, as declared in `medusa-config`.
 */
export type CustomFieldConfig = {
  type: CustomFieldTypeValue
  /**
   * The permitted values, for `enum` fields. Required for them and rejected
   * for anything else.
   */
  choices?: string[]
  /**
   * Enforced by the module service on every write and, for callers arriving
   * over HTTP, by the generated request validator.
   */
  required?: boolean
  /**
   * Create a database index on the satellite column.
   */
  indexed?: boolean
  /**
   * The value an omitted field takes, mirroring DML's `.default()`:
   *
   * - Validated at boot the way a written value would be — a type-invalid
   *   default fails startup, not the first write.
   * - Fills omissions on create, *including on a `required` field* — a default
   *   satisfies the requirement, exactly as `.default(false)` does on a
   *   non-nullable DML column. An explicit null is a statement, not an
   *   omission: it clears the value (or is rejected when `required`).
   * - Emitted as a real column DEFAULT through the satellite's DML property,
   *   so adding a defaulted field to a populated satellite backfills the
   *   existing rows.
   * - An owner that states no custom field values at all still keeps no
   *   satellite row — defaults apply when a row is created, the same way
   *   DML's fill runs at record creation.
   */
  default_value?: unknown
  /**
   * Display label for the admin dashboard. Falls back to a humanized key.
   */
  label?: string
  description?: string
}

/**
 * A resolved definition — a {@link CustomFieldConfig} with its entity and key
 * attached and defaults applied. This is what the rest of the module works
 * with.
 */
export type CustomFieldDefinition = Required<
  Pick<CustomFieldConfig, "type" | "required" | "indexed">
> &
  Pick<
    CustomFieldConfig,
    "default_value" | "label" | "description" | "choices"
  > & {
    /**
     * The core entity the field is attached to, matching the resource a route
     * declares in its `policies` — for example `product` or `product_variant`.
     */
    entity: string
    /**
     * Unique per entity. Used verbatim as the satellite column name and as the
     * key clients send in request bodies.
     */
    key: string
  }

/**
 * One owner's satellite row as it stood before a write — captured by
 * `snapshotValues`, consumed by `restoreValues` when a workflow compensates.
 */
export type SatelliteSnapshotRecord = {
  id: string
  /**
   * Whether a satellite row existed at snapshot time. `values` alone cannot
   * say: an empty object is also what a row of nulls reads back as. Restoring
   * a record that had no row deletes the one the write created, so an owner
   * that stated nothing keeps no row.
   */
  existed: boolean
  /**
   * The row's `deleted_at` at snapshot time, so a restore puts back the exact
   * state — a soft-deleted row comes back soft-deleted, not resurrected.
   */
  deleted_at?: string | Date | null
  values: Record<string, unknown>
}

/**
 * Module options, as passed in `medusa-config`.
 *
 * Configuration is the single source of truth. Definitions are read once at
 * boot because the entity graph — MikroORM metadata, the merged GraphQL
 * schema, and the query catalog — is assembled at startup and has no
 * invalidation path. Storing definitions in a table as well would add a second
 * source of truth without removing the restart.
 *
 * @example
 * ```ts
 * modules: [
 *   {
 *     resolve: "@medusajs/medusa/custom-fields",
 *     options: {
 *       fields: {
 *         product: {
 *           brand: { type: "text", required: true },
 *           manufacturer: { type: "text" },
 *         },
 *       },
 *     },
 *   },
 * ]
 * ```
 */
export type CustomFieldsModuleOptions = {
  fields?: Record<string, Record<string, CustomFieldConfig>>
}
