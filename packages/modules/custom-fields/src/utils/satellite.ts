import { toPascalCase } from "@medusajs/framework/utils"

/**
 * Values for an entity's custom fields live in a satellite table owned by this
 * module — one per entity, holding a real typed column per definition and the
 * owning entity's id. Nothing is written to the core module's own tables, so
 * this module never touches another module's schema or migration history.
 */
export function satelliteTableName(entity: string): string {
  return `${entity}_custom_field`
}

/**
 * The satellite's model name, e.g. `product` -> `ProductCustomField`.
 */
export function satelliteEntityName(entity: string): string {
  return toPascalCase(`${entity}_custom_field`)
}

/**
 * The column holding the owning entity's id, e.g. `product` -> `product_id`.
 * This is the satellite's primary key: the relationship is 1:1.
 */
export function ownerColumnName(entity: string): string {
  return `${entity}_id`
}

/**
 * There is deliberately no column-type map here. The satellite is described by
 * its DML entity and nothing else: the planner hands that entity to MikroORM,
 * which decides the column type exactly as it would for any model. A second
 * mapping maintained by hand is what let the entity say `integer` while the
 * column was `numeric`, and reads come back as strings.
 *
 * The one type that is not a straight passthrough is `enum`, which is built as
 * `model.text()` — see `propertyFor` in `satellite-registry.ts`.
 */

/**
 * Postgres identifiers are quoted rather than escaped, so anything reaching DDL
 * has to be known-safe first. Definition keys and entity names are validated on
 * write, but this is the last line before raw SQL and cheap to keep.
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

export function assertSafeIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new Error(
      `Invalid ${label} "${value}": expected lower snake case matching ${IDENTIFIER}`
    )
  }
}

/**
 * Reserved because they are managed by the satellite itself, not by definitions.
 */
export const RESERVED_KEYS = new Set([
  "id",
  "created_at",
  "updated_at",
  "deleted_at",
])
