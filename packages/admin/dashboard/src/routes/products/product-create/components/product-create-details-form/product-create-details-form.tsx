import { Divider, Heading, Text } from "@medusajs/ui"
import { UseFormReturn } from "react-hook-form"
import { useTranslation } from "react-i18next"

import { CustomFieldInput } from "../../../../../components/custom-fields/custom-field-input"
import { CustomFieldValue } from "../../../../../components/custom-fields/custom-field-value"
import { FormExtensionZone } from "../../../../../dashboard-app"
import {
  CustomFieldDefinition,
  getCustomFieldLabel,
} from "../../../../../lib/custom-fields"
import { useExtension } from "../../../../../providers/extension-provider"
import { ProductCreateSchemaType } from "../../types"
import { ProductCreateGeneralSection } from "./components/product-create-details-general-section"
import { ProductCreateMediaSection } from "./components/product-create-details-media-section"
import { ProductCreateVariantsSection } from "./components/product-create-details-variant-section"

type ProductAttributesProps = {
  form: UseFormReturn<ProductCreateSchemaType>
  customFieldDefinitions?: CustomFieldDefinition[]
}

export const ProductCreateDetailsForm = ({
  form,
  customFieldDefinitions = [],
}: ProductAttributesProps) => {
  const { getFormFields } = useExtension()
  const fields = getFormFields("product", "create", "general")

  return (
    <div className="flex flex-col items-center p-16">
      <div className="flex w-full max-w-[720px] flex-col gap-y-8">
        <Header />
        <div className="flex flex-col gap-y-6">
          <ProductCreateGeneralSection form={form} />
          <FormExtensionZone fields={fields} form={form} />
          <ProductCreateCustomFieldsSection
            form={form}
            definitions={customFieldDefinitions}
          />
          <ProductCreateMediaSection form={form} />
        </div>
        <Divider />
        <ProductCreateVariantsSection form={form} />
      </div>
    </div>
  )
}

const Header = () => {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col">
      <Heading>{t("products.create.header")}</Heading>
    </div>
  )
}

const ProductCreateCustomFieldsSection = ({
  form,
  definitions,
}: {
  form: UseFormReturn<ProductCreateSchemaType>
  definitions: CustomFieldDefinition[]
}) => {
  const { t } = useTranslation()

  // A readonly field with no default has nothing to show on a create — it is
  // omitted; with a default, it renders as plain text so the operator can see
  // what the record will be created with.
  const visible = definitions.filter(
    (definition) =>
      !definition.readonly || definition.default_value !== undefined
  )

  if (!visible.length) {
    return null
  }

  return (
    <div id="custom-fields" className="flex flex-col gap-y-6">
      <Heading level="h2">{t("customFields.header")}</Heading>
      <div className="flex flex-col gap-y-4">
        {visible.map((definition) =>
          definition.readonly ? (
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
                  value={definition.default_value}
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
    </div>
  )
}
