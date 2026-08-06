import { zodResolver } from "@hookform/resolvers/zod"
import { HttpTypes } from "@medusajs/types"
import { Button, Text, toast } from "@medusajs/ui"
import { useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { z } from "zod"

import { CustomFieldInput } from "../../../../../components/custom-fields/custom-field-input"
import { CustomFieldValue } from "../../../../../components/custom-fields/custom-field-value"
import { RouteDrawer, useRouteModal } from "../../../../../components/modals"
import { KeyboundForm } from "../../../../../components/utilities/keybound-form"
import { useUpdateProduct } from "../../../../../hooks/api/products"
import {
  applyCustomFieldServerError,
  buildCustomFieldsSchema,
  CustomFieldDefinition,
  CustomFieldFormValues,
  getCustomFieldFormDefaults,
  getCustomFieldLabel,
  serializeCustomFieldValues,
} from "../../../../../lib/custom-fields"

type ProductCustomFieldsFormProps = {
  product: HttpTypes.AdminProduct
  definitions: CustomFieldDefinition[]
}

export const ProductCustomFieldsForm = ({
  product,
  definitions,
}: ProductCustomFieldsFormProps) => {
  const { t } = useTranslation()
  const { handleSuccess } = useRouteModal()

  const form = useForm({
    defaultValues: {
      custom_fields: getCustomFieldFormDefaults(
        definitions,
        product.custom_fields
      ),
    },
    resolver: zodResolver(
      z.object({
        custom_fields: buildCustomFieldsSchema(definitions, { partial: true }),
      })
    ),
  })

  const { mutateAsync, isPending } = useUpdateProduct(product.id)

  const handleSubmit = form.handleSubmit(async (data) => {
    const dirtyKeys = Object.keys(
      form.formState.dirtyFields.custom_fields ?? {}
    )

    const customFields = serializeCustomFieldValues(
      definitions,
      data.custom_fields as CustomFieldFormValues,
      { mode: "update", dirtyKeys }
    )

    if (!customFields) {
      handleSuccess()
      return
    }

    await mutateAsync(
      { custom_fields: customFields },
      {
        onSuccess: () => {
          toast.success(t("customFields.edit.successToast"))
          handleSuccess()
        },
        onError: (error) => {
          const matched = applyCustomFieldServerError(
            error,
            definitions,
            (name, fieldError) => form.setError(name as any, fieldError)
          )

          if (!matched) {
            toast.error(error.message)
          }
        },
      }
    )
  })

  return (
    <RouteDrawer.Form form={form}>
      <KeyboundForm
        onSubmit={handleSubmit}
        className="flex flex-1 flex-col overflow-hidden"
      >
        <RouteDrawer.Body className="flex flex-1 flex-col overflow-y-auto">
          <div className="flex flex-col gap-y-4">
            {definitions.map((definition) =>
              definition.readonly ? (
                // A readonly field is never an input control — it renders as
                // plain text alongside the writable inputs, so the full field
                // set stays visible in context.
                <div key={definition.key} className="flex flex-col space-y-2">
                  <Text size="small" leading="compact" weight="plus">
                    {getCustomFieldLabel(definition)}
                  </Text>
                  <Text
                    size="small"
                    leading="compact"
                    className="text-ui-fg-subtle"
                  >
                    <CustomFieldValue
                      definition={definition}
                      value={product.custom_fields?.[definition.key]}
                    />
                  </Text>
                </div>
              ) : (
                <CustomFieldInput
                  key={definition.key}
                  definition={definition}
                  control={form.control}
                  name={`custom_fields.${definition.key}`}
                />
              )
            )}
          </div>
        </RouteDrawer.Body>
        <RouteDrawer.Footer>
          <div className="flex items-center justify-end gap-x-2">
            <RouteDrawer.Close asChild>
              <Button size="small" variant="secondary">
                {t("actions.cancel")}
              </Button>
            </RouteDrawer.Close>
            <Button size="small" type="submit" isLoading={isPending}>
              {t("actions.save")}
            </Button>
          </div>
        </RouteDrawer.Footer>
      </KeyboundForm>
    </RouteDrawer.Form>
  )
}
