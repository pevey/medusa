import { DatePicker, Input, Text, Textarea } from "@medusajs/ui"
import { Control, FieldPath, FieldValues } from "react-hook-form"

import {
  CustomFieldDefinition,
  getCustomFieldLabel,
} from "../../lib/custom-fields"
import { Form } from "../common/form"
import { SwitchBox } from "../common/switch-box"
import { Combobox } from "../inputs/combobox"

interface CustomFieldInputProps<
  TFieldValues extends FieldValues = FieldValues
> {
  definition: CustomFieldDefinition
  control: Control<TFieldValues>
  /**
   * The form path of the field — for example `custom_fields.brand`. Field
   * paths are built from runtime definitions, so they cannot be statically
   * known; the casts below are contained to this component.
   */
  name: string
}

/**
 * The one place that maps a custom field type to an input. Every form that
 * renders custom fields — create, edit — goes through this dispatcher, so a
 * new field type is wired here once. An unrecognized type (config newer than
 * this dashboard build) renders a disabled input rather than crashing.
 */
export const CustomFieldInput = <TFieldValues extends FieldValues = FieldValues>({
  definition,
  control,
  name: unsafeName,
}: CustomFieldInputProps<TFieldValues>) => {
  const name = unsafeName as FieldPath<TFieldValues>
  const label = getCustomFieldLabel(definition)
  const optional = !definition.required

  // Readonly fields are display-only everywhere; callers filter them out, and
  // this guard keeps a missed one from rendering an editable control.
  if (definition.readonly) {
    return null
  }

  if (definition.type === "boolean") {
    return (
      <SwitchBox
        control={control}
        name={name}
        label={label}
        description={definition.description ?? ""}
        optional={optional}
      />
    )
  }

  switch (definition.type) {
    case "text":
      return (
        <Form.Field
          control={control}
          name={name}
          render={({ field }) => (
            <Form.Item>
              <Form.Label optional={optional}>{label}</Form.Label>
              <Form.Control>
                <Input {...field} />
              </Form.Control>
              {definition.description && (
                <Form.Hint>{definition.description}</Form.Hint>
              )}
              <Form.ErrorMessage />
            </Form.Item>
          )}
        />
      )
    case "number":
    case "float":
      return (
        <Form.Field
          control={control}
          name={name}
          render={({ field: { onChange, value, ...field } }) => (
            <Form.Item>
              <Form.Label optional={optional}>{label}</Form.Label>
              <Form.Control>
                <Input
                  type="number"
                  step={definition.type === "number" ? 1 : "any"}
                  min={definition.min as number | undefined}
                  max={definition.max as number | undefined}
                  value={value ?? ""}
                  onChange={(e) => {
                    const next = e.target.value

                    if (next === "") {
                      onChange(null)
                    } else {
                      onChange(
                        definition.type === "number"
                          ? parseInt(next, 10)
                          : parseFloat(next)
                      )
                    }
                  }}
                  {...field}
                />
              </Form.Control>
              {definition.description && (
                <Form.Hint>{definition.description}</Form.Hint>
              )}
              <Form.ErrorMessage />
            </Form.Item>
          )}
        />
      )
    case "enum":
      return (
        <Form.Field
          control={control}
          name={name}
          render={({ field: { onChange, value, ...field } }) => (
            <Form.Item>
              <Form.Label optional={optional}>{label}</Form.Label>
              <Form.Control>
                <Combobox
                  {...field}
                  value={value || undefined}
                  onChange={(next?: string) => onChange(next ?? "")}
                  options={(definition.choices ?? []).map((choice) => ({
                    label: choice,
                    value: choice,
                  }))}
                  allowClear={optional}
                />
              </Form.Control>
              {definition.description && (
                <Form.Hint>{definition.description}</Form.Hint>
              )}
              <Form.ErrorMessage />
            </Form.Item>
          )}
        />
      )
    case "date":
    case "dateTime": {
      const isDateOnly = definition.type === "date"

      // Bounds arrive as ISO strings; date-only bounds parse without a
      // timezone suffix so they land on local midnight, matching the values.
      const minValue = definition.min
        ? new Date(
            isDateOnly ? `${definition.min}T00:00:00` : (definition.min as string)
          )
        : undefined
      const maxValue = definition.max
        ? new Date(
            isDateOnly ? `${definition.max}T23:59:59.999` : (definition.max as string)
          )
        : undefined

      return (
        <Form.Field
          control={control}
          name={name}
          render={({ field }) => (
            <Form.Item>
              <Form.Label optional={optional}>{label}</Form.Label>
              <Form.Control>
                <DatePicker
                  granularity={isDateOnly ? "day" : "minute"}
                  minValue={minValue}
                  maxValue={maxValue}
                  {...field}
                />
              </Form.Control>
              {definition.description && (
                <Form.Hint>{definition.description}</Form.Hint>
              )}
              <Form.ErrorMessage />
            </Form.Item>
          )}
        />
      )
    }
    case "json":
      return (
        <Form.Field
          control={control}
          name={name}
          render={({ field }) => (
            <Form.Item>
              <Form.Label optional={optional}>{label}</Form.Label>
              <Form.Control>
                <Textarea {...field} rows={4} className="font-mono" />
              </Form.Control>
              {definition.description && (
                <Form.Hint>{definition.description}</Form.Hint>
              )}
              <Form.ErrorMessage />
            </Form.Item>
          )}
        />
      )
    default:
      return (
        <div className="flex flex-col space-y-2">
          <Text size="small" leading="compact" weight="plus">
            {label}
          </Text>
          <Input disabled placeholder="Unsupported field type" />
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            This dashboard version does not support the field type "
            {definition.type}".
          </Text>
        </div>
      )
  }
}
