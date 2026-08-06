import { PencilSquare } from "@medusajs/icons"
import { HttpTypes } from "@medusajs/types"
import { Container, Heading } from "@medusajs/ui"
import { useTranslation } from "react-i18next"

import { ActionMenu } from "../../../../../components/common/action-menu"
import { SectionRow } from "../../../../../components/common/section"
import { CustomFieldValue } from "../../../../../components/custom-fields/custom-field-value"
import { useCustomFieldDefinitions } from "../../../../../hooks/api/custom-fields"
import { useProduct } from "../../../../../hooks/api/products"
import {
  getCustomFieldLabel,
  getWritableDefinitions,
} from "../../../../../lib/custom-fields"

type ProductCustomFieldsSectionProps = {
  product: HttpTypes.AdminProduct
}

export const ProductCustomFieldsSection = ({
  product,
}: ProductCustomFieldsSectionProps) => {
  const { t } = useTranslation()
  const { definitions } = useCustomFieldDefinitions("product")

  /**
   * The values load through their own display query rather than the detail
   * loader: `PRODUCT_DETAIL_FIELDS` is a static constant, and a hardcoded
   * `*custom_fields` selector there would break against servers where the
   * feature flag is off and the link does not exist. The key sits under
   * `productsQueryKeys.detail(id)`, so the existing product mutations
   * invalidate it.
   */
  const { product: productWithCustomFields } = useProduct(
    product.id,
    { fields: "id,*custom_fields" },
    { enabled: !!definitions.length }
  )

  if (!definitions.length) {
    return null
  }

  const values = productWithCustomFields?.custom_fields ?? {}
  const hasWritableFields = getWritableDefinitions(definitions).length > 0

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">{t("customFields.header")}</Heading>
        {hasWritableFields && (
          <ActionMenu
            groups={[
              {
                actions: [
                  {
                    label: t("actions.edit"),
                    to: "custom-fields",
                    icon: <PencilSquare />,
                  },
                ],
              },
            ]}
          />
        )}
      </div>
      {definitions.map((definition) => (
        <SectionRow
          key={definition.key}
          title={getCustomFieldLabel(definition)}
          value={
            <CustomFieldValue
              definition={definition}
              value={values[definition.key]}
            />
          }
        />
      ))}
    </Container>
  )
}
