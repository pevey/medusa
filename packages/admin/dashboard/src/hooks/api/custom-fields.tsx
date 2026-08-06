import { FetchError } from "@medusajs/js-sdk"
import { HttpTypes } from "@medusajs/types"
import { QueryKey, useQuery, UseQueryOptions } from "@tanstack/react-query"

import { sdk } from "../../lib/client"
import { queryKeysFactory } from "../../lib/query-key-factory"
import { useFeatureFlag } from "../../providers/feature-flag-provider"

const CUSTOM_FIELDS_QUERY_KEY = "custom_fields" as const
export const customFieldsQueryKeys = queryKeysFactory(CUSTOM_FIELDS_QUERY_KEY)

/**
 * The custom field definitions configured for an entity. Definitions only
 * change on a server restart, so they are cached generously. When the
 * `custom_fields` feature flag is off the query never fires and `definitions`
 * resolves to an empty list.
 */
export const useCustomFieldDefinitions = (
  entity: string,
  options?: Omit<
    UseQueryOptions<
      HttpTypes.AdminCustomFieldDefinitionListResponse,
      FetchError,
      HttpTypes.AdminCustomFieldDefinitionListResponse,
      QueryKey
    >,
    "queryFn" | "queryKey"
  >
) => {
  const isEnabled = useFeatureFlag("custom_fields")

  const { data, ...rest } = useQuery({
    queryFn: () => sdk.admin.customFields.list({ entity }),
    queryKey: customFieldsQueryKeys.list({ entity }),
    staleTime: 5 * 60 * 1000,
    ...options,
    enabled: isEnabled && (options?.enabled ?? true),
  })

  return {
    definitions: isEnabled ? data?.definitions ?? [] : [],
    ...rest,
  }
}
