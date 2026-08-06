import { useTranslation } from "react-i18next"

import { useDate } from "../../hooks/use-date"
import { CustomFieldDefinition } from "../../lib/custom-fields"

/**
 * Read-only rendering of a custom field value, shared by the detail section
 * and the plain-text rows readonly fields get in forms. Formatting is
 * type-aware; absent values render as a dash.
 */
export const CustomFieldValue = ({
  definition,
  value,
}: {
  definition: CustomFieldDefinition
  value: unknown
}) => {
  const { t } = useTranslation()
  const { getFullDate } = useDate()

  if (value === null || value === undefined) {
    return <>-</>
  }

  switch (definition.type) {
    case "boolean":
      return <>{value ? t("fields.true") : t("fields.false")}</>
    // Parsed WITHOUT a timezone suffix so the rendered calendar date matches
    // the stored one for every viewer offset.
    case "date":
      return <>{getFullDate({ date: `${value}T00:00:00` })}</>
    case "dateTime":
      return (
        <>{getFullDate({ date: value as string | Date, includeTime: true })}</>
      )
    case "json":
      return (
        <span className="truncate font-mono" title={JSON.stringify(value)}>
          {JSON.stringify(value)}
        </span>
      )
    default:
      return <>{String(value)}</>
  }
}
