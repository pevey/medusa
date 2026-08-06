import { HttpTypes } from "@medusajs/types"
import { z } from "zod"

/**
 * Form-layer machinery for custom fields: the JSON descriptor -> zod mapper,
 * the form <-> wire value converters, and the server-error -> form-field
 * mapper. Every form that renders custom field inputs goes through this file,
 * so the empty-vs-null semantics are decided exactly once:
 *
 * - An empty input on a create is an omission - the value is left out of the
 *   payload so the server can apply defaults and the no-values-no-row
 *   invariant holds.
 * - An empty input on an update is a statement - it serializes to an explicit
 *   `null`, which clears the value.
 * - Only dirty fields are ever serialized, so untouched inputs never write.
 */

export type CustomFieldDefinition = HttpTypes.AdminCustomFieldDefinition

export type CustomFieldFormValue = string | number | boolean | Date | null

export type CustomFieldFormValues = Record<string, CustomFieldFormValue>

const REQUIRED_MESSAGE = "This field is required"

export const getCustomFieldLabel = (definition: CustomFieldDefinition) => {
  return definition.label ?? humanizeKey(definition.key)
}

const humanizeKey = (key: string) => {
  return key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ")
}

/**
 * The definitions a form renders inputs for. Readonly fields are display-only
 * everywhere — never an input control — so every form-facing helper works
 * from this subset.
 */
export const getWritableDefinitions = (
  definitions: CustomFieldDefinition[]
): CustomFieldDefinition[] => {
  return definitions.filter((definition) => !definition.readonly)
}

/**
 * Build the zod shape for a set of definitions. With `partial` (update
 * forms), a required field must stay non-empty — clearing it is an explicit
 * null, which the server refuses. On create, a required field with a
 * configured default may be left empty: the omission is filled server-side,
 * exactly as DML's `.default()` satisfies a non-nullable column.
 *
 * Readonly fields are excluded: they have no inputs, so they have nothing to
 * validate.
 */
export const buildCustomFieldsSchema = (
  definitions: CustomFieldDefinition[],
  options: { partial?: boolean } = {}
) => {
  const shape: Record<string, z.ZodType> = {}

  for (const definition of getWritableDefinitions(definitions)) {
    shape[definition.key] = buildFieldSchema(definition, options)
  }

  return z.object(shape)
}

const buildFieldSchema = (
  definition: CustomFieldDefinition,
  { partial }: { partial?: boolean }
): z.ZodType => {
  const enforceRequired =
    definition.required && (partial || definition.default_value === undefined)

  switch (definition.type) {
    case "text":
      return enforceRequired
        ? z.string().min(1, REQUIRED_MESSAGE)
        : z.string()
    case "enum": {
      const choices = definition.choices ?? []
      const base = z
        .string()
        .refine((value) => value === "" || choices.includes(value), {
          message: `Expected one of: ${choices.join(", ")}`,
        })
      return enforceRequired
        ? base.refine((value) => value !== "", { message: REQUIRED_MESSAGE })
        : base
    }
    case "number":
    case "float": {
      let numeric =
        definition.type === "number"
          ? z.number().int("Must be a whole number")
          : z.number()

      if (typeof definition.min === "number") {
        numeric = numeric.min(
          definition.min,
          `Must be at least ${definition.min}`
        )
      }

      if (typeof definition.max === "number") {
        numeric = numeric.max(
          definition.max,
          `Must be at most ${definition.max}`
        )
      }

      const base = z.union([numeric, z.null()])
      return enforceRequired
        ? base.refine((value) => value !== null, { message: REQUIRED_MESSAGE })
        : base
    }
    case "boolean":
      return z.boolean()
    case "date":
    case "dateTime": {
      let base: z.ZodType = z.union([z.date(), z.null()])

      if (definition.min !== undefined) {
        const min =
          definition.type === "date"
            ? new Date(`${definition.min}T00:00:00`)
            : new Date(definition.min as string)
        base = base.refine(
          (value) => value == null || (value as Date) >= min,
          { message: `Must be on or after ${definition.min}` }
        )
      }

      if (definition.max !== undefined) {
        const max =
          definition.type === "date"
            ? new Date(`${definition.max}T23:59:59.999`)
            : new Date(definition.max as string)
        base = base.refine(
          (value) => value == null || (value as Date) <= max,
          { message: `Must be on or before ${definition.max}` }
        )
      }

      return enforceRequired
        ? base.refine((value) => value !== null, { message: REQUIRED_MESSAGE })
        : base
    }
    case "json": {
      const base = z.string().refine(
        (value) => {
          if (!value.trim()) {
            return true
          }

          try {
            JSON.parse(value)
            return true
          } catch {
            return false
          }
        },
        { message: "Must be valid JSON" }
      )
      return enforceRequired
        ? base.refine((value) => value.trim() !== "", {
            message: REQUIRED_MESSAGE,
          })
        : base
    }
    default:
      // A type this dashboard build does not know. The input renders
      // disabled; accept whatever is there so the rest of the form works.
      return z.any()
  }
}

/**
 * Form default values. With `current` (update forms) the record's stored
 * values are the source; without it (create forms) the configured
 * `default_value` prefills — Vendure omits the configured default from its
 * descriptor and prefills type-based zeros instead, which silently diverges
 * from what the server will write.
 */
export const getCustomFieldFormDefaults = (
  definitions: CustomFieldDefinition[],
  current?: Record<string, unknown> | null
): CustomFieldFormValues => {
  const values: CustomFieldFormValues = {}

  for (const definition of getWritableDefinitions(definitions)) {
    const source = current ? current[definition.key] : definition.default_value
    values[definition.key] = toFormValue(definition, source)
  }

  return values
}

const toFormValue = (
  definition: CustomFieldDefinition,
  source: unknown
): CustomFieldFormValue => {
  switch (definition.type) {
    case "text":
    case "enum":
      return typeof source === "string" ? source : ""
    case "number":
    case "float":
      return typeof source === "number" ? source : null
    case "boolean":
      return typeof source === "boolean" ? source : false
    // The stored value is a calendar date; parsing it WITHOUT a timezone
    // suffix yields local midnight, so the DatePicker shows the same calendar
    // date the value names regardless of the viewer's offset.
    case "date":
      return typeof source === "string" && source
        ? new Date(`${source}T00:00:00`)
        : null
    case "dateTime":
      return source ? new Date(source as string | number | Date) : null
    case "json":
      return source == null
        ? ""
        : typeof source === "string"
        ? source
        : JSON.stringify(source, null, 2)
    default:
      return typeof source === "string" ? source : ""
  }
}

/**
 * Form -> wire. Only keys listed in `dirtyKeys` are emitted, so untouched
 * inputs write nothing — on update that leaves stored values alone, and on
 * create it keeps the no-values-no-row invariant (and lets server-side
 * defaults fill omissions). Returns `undefined` when nothing is dirty, so
 * callers can omit the `custom_fields` key from the payload entirely.
 */
export const serializeCustomFieldValues = (
  definitions: CustomFieldDefinition[],
  values: CustomFieldFormValues | undefined,
  options: { mode: "create" | "update"; dirtyKeys: string[] }
): Record<string, unknown> | undefined => {
  const out: Record<string, unknown> = {}

  for (const definition of getWritableDefinitions(definitions)) {
    if (!options.dirtyKeys.includes(definition.key)) {
      continue
    }

    const raw = values?.[definition.key]

    if (isEmptyFormValue(definition, raw)) {
      if (options.mode === "update") {
        out[definition.key] = null
      }

      continue
    }

    out[definition.key] = toWireValue(definition, raw!)
  }

  return Object.keys(out).length ? out : undefined
}

const isEmptyFormValue = (
  definition: CustomFieldDefinition,
  value: CustomFieldFormValue | undefined
): boolean => {
  if (definition.type === "boolean") {
    // A switch always states a value; a dirty boolean is never an omission.
    return value == null
  }

  return value == null || value === ""
}

const toWireValue = (
  definition: CustomFieldDefinition,
  value: CustomFieldFormValue
): unknown => {
  switch (definition.type) {
    // Serialized from the LOCAL date parts, never `toISOString()`: the picker
    // holds local midnight, and converting through UTC would shift the
    // calendar date for viewers east of Greenwich — the exact off-by-one bug
    // the `date` type exists to prevent.
    case "date":
      return value instanceof Date ? formatLocalIsoDate(value) : value
    case "dateTime":
      return value instanceof Date ? value.toISOString() : value
    case "json":
      return typeof value === "string" ? JSON.parse(value) : value
    default:
      return value
  }
}

const formatLocalIsoDate = (value: Date): string => {
  const year = value.getFullYear().toString().padStart(4, "0")
  const month = (value.getMonth() + 1).toString().padStart(2, "0")
  const day = value.getDate().toString().padStart(2, "0")
  return `${year}-${month}-${day}`
}

/**
 * Map a server-side validation error back onto the offending input. The
 * module's errors name the key in single quotes ("Field 'brand' is
 * required"), so a match sets the error on `custom_fields.<key>` and the
 * caller skips its toast. Returns whether a field matched.
 */
export const applyCustomFieldServerError = (
  error: { message?: string } | null | undefined,
  definitions: CustomFieldDefinition[],
  setError: (
    name: string,
    error: { type: string; message: string }
  ) => void
): boolean => {
  const message = error?.message

  if (!message) {
    return false
  }

  for (const definition of definitions) {
    if (message.includes(`'${definition.key}'`)) {
      setError(`custom_fields.${definition.key}`, {
        type: "server",
        message,
      })
      return true
    }
  }

  return false
}
