import { DmlEntity, isDefined, model } from "@medusajs/framework/utils"
import { CustomFieldDefinition, CustomFieldType } from "@/types"
import {
  assertSafeIdentifier,
  ownerColumnName,
  satelliteTableName,
} from "./satellite"

/**
 * Satellite entities are derived from configuration at boot, so they cannot be
 * discovered from `src/models` like a static model. The connection loader
 * builds them and records them here; the module service reads them back when it
 * assembles its joiner config, which is what puts them in the entity graph and
 * makes `product.custom_fields` traversable.
 */
const SATELLITES = new Map<string, DmlEntity<any, any>>()
const DEFINITIONS = new Map<string, CustomFieldDefinition[]>()

export function getSatellites(): Map<string, DmlEntity<any, any>> {
  return SATELLITES
}

export function getSatellite(entity: string): DmlEntity<any, any> | undefined {
  return SATELLITES.get(entity)
}

/**
 * The resolved definitions behind the satellites, kept alongside them so the
 * service can validate values without re-reading configuration.
 */
export function getDefinitions(entity: string): CustomFieldDefinition[] {
  return DEFINITIONS.get(entity) ?? []
}

export function getConfiguredEntities(): string[] {
  return [...DEFINITIONS.keys()]
}

/**
 * The DML property behind a definition. Kept in step with `COLUMN_TYPES` in
 * `satellite.ts`: this decides what the entity metadata says a column is, that
 * decides what the column actually is, and they have to agree.
 *
 * `enum` uses `model.text()` deliberately — see the note on `COLUMN_TYPES`.
 */
function propertyFor(definition: CustomFieldDefinition) {
  switch (definition.type) {
    case CustomFieldType.number:
      return model.number()
    case CustomFieldType.float:
      return model.float()
    case CustomFieldType.boolean:
      return model.boolean()
    case CustomFieldType.dateTime:
      return model.dateTime()
    case CustomFieldType.json:
      return model.json()
    case CustomFieldType.text:
    case CustomFieldType.enum:
    default:
      return model.text()
  }
}

/**
 * Build the satellite model for one entity.
 *
 * The owning entity's id is the satellite's primary key — the relationship is
 * 1:1 — which lets the read-only link join `product.id` straight to
 * `product_custom_field.product_id` without a link table in between.
 */
export function buildSatellite(
  entity: string,
  definitions: CustomFieldDefinition[]
): DmlEntity<any, any> {
  assertSafeIdentifier(entity, "entity name")

  const schema: Record<string, any> = {
    [ownerColumnName(entity)]: model.text().primaryKey(),
  }

  for (const definition of definitions) {
    assertSafeIdentifier(definition.key, "custom field key")

    let property = propertyFor(definition)

    // Applied to the DML property the way a model author would write
    // `.default(...)`, so the planner emits a real column DEFAULT — which also
    // backfills existing rows when a defaulted field is added to a populated
    // satellite. Write-time filling is handled by `validateValues`, mirroring
    // DML's own BeforeCreate hook.
    if (isDefined(definition.default_value)) {
      property = (property as any).default(definition.default_value)
    }

    // Index and default before nullable: `nullable()` returns a modifier that
    // no longer exposes the property builder's methods.
    if (definition.indexed) {
      property = property.index() as any
    }

    // Always nullable at the ORM level. A satellite row may not exist yet for
    // an owner created before the field was declared, and a column cannot be
    // added `not null` to a populated table without a default. Required-ness is
    // enforced by the module service on every write instead.
    property = property.nullable() as any

    schema[definition.key] = property
  }

  const satellite = model.define(satelliteTableName(entity), schema)

  SATELLITES.set(entity, satellite)
  DEFINITIONS.set(entity, definitions)

  return satellite
}

export function buildSatellites(
  definitionsByEntity: Map<string, CustomFieldDefinition[]>
): DmlEntity<any, any>[] {
  SATELLITES.clear()
  DEFINITIONS.clear()

  return [...definitionsByEntity.entries()].map(([entity, definitions]) =>
    buildSatellite(entity, definitions)
  )
}
