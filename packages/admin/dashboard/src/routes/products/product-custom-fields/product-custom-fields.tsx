import { Heading } from "@medusajs/ui"
import { useTranslation } from "react-i18next"
import { useParams } from "react-router-dom"

import { RouteDrawer } from "../../../components/modals"
import { useCustomFieldDefinitions } from "../../../hooks/api/custom-fields"
import { useProduct } from "../../../hooks/api/products"
import { ProductCustomFieldsForm } from "./components/product-custom-fields-form"

export const ProductCustomFields = () => {
  const { id } = useParams()
  const { t } = useTranslation()

  const { definitions } = useCustomFieldDefinitions("product")

  const { product, isLoading, isError, error } = useProduct(id!, {
    fields: "id,*custom_fields",
  })

  if (isError) {
    throw error
  }

  return (
    <RouteDrawer>
      <RouteDrawer.Header>
        <RouteDrawer.Title asChild>
          <Heading>{t("customFields.edit.header")}</Heading>
        </RouteDrawer.Title>
        <RouteDrawer.Description className="sr-only">
          {t("customFields.edit.description")}
        </RouteDrawer.Description>
      </RouteDrawer.Header>
      {!isLoading && product && !!definitions.length && (
        <ProductCustomFieldsForm product={product} definitions={definitions} />
      )}
    </RouteDrawer>
  )
}
