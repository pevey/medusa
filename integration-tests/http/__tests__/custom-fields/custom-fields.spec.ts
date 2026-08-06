import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import {
  adminHeaders,
  createAdminUser,
  generatePublishableKey,
  generateStoreHeaders,
} from "../../../helpers/create-admin-user"

jest.setTimeout(300000)

process.env.MEDUSA_FF_CUSTOM_FIELDS = "true"

// The fields configured for `product` in the shared medusa-config:
// brand (text, required, indexed) and manufacturer (text, optional).

const productPayload = (overrides: Record<string, unknown> = {}) => ({
  title: `CF Product ${Math.random().toString(36).slice(2)}`,
  options: [{ title: "size", values: ["l"] }],
  ...overrides,
})

medusaIntegrationTestRunner({
  testSuite: ({ dbConnection, getContainer, api }) => {
    describe("Custom fields (workflow approach)", () => {
      beforeEach(async () => {
        await createAdminUser(dbConnection, adminHeaders, getContainer())
      })

      afterAll(() => {
        delete process.env.MEDUSA_FF_CUSTOM_FIELDS
      })

      const satelliteRow = async (productId: string) => {
        const rows = await dbConnection.raw(
          `select * from product_custom_field where product_id = ?`,
          [productId]
        )
        return rows.rows[0]
      }

      describe("create", () => {
        it("persists custom fields to the satellite table and returns them nested", async () => {
          const created = await api.post(
            "/admin/products",
            productPayload({ custom_fields: { brand: "Acme", manufacturer: "Acme Corp" } }),
            adminHeaders
          )

          expect(created.status).toEqual(200)
          const productId = created.data.product.id

          const row = await satelliteRow(productId)
          expect(row).toEqual(
            expect.objectContaining({
              product_id: productId,
              brand: "Acme",
              manufacturer: "Acme Corp",
            })
          )

          const fetched = await api.get(
            `/admin/products/${productId}`,
            adminHeaders
          )
          expect(fetched.data.product.custom_fields).toEqual(
            expect.objectContaining({ brand: "Acme", manufacturer: "Acme Corp" })
          )
        })

        it("rejects a create missing a required custom field before any write", async () => {
          const title = "CF Missing Required"
          const err = await api
            .post("/admin/products", productPayload({ title }), adminHeaders)
            .catch((e) => e)

          expect(err.response.status).toEqual(400)
          expect(err.response.data.message).toContain("brand")

          const rows = await dbConnection.raw(
            `select count(*)::int as n from product where title = ?`,
            [title]
          )
          expect(rows.rows[0].n).toEqual(0)
        })

        it("applies defaults for omitted fields, including satisfying required", async () => {
          const created = await api.post(
            "/admin/products",
            productPayload({ custom_fields: { brand: "Defaulted" } }),
            adminHeaders
          )

          expect(created.status).toEqual(200)

          // `warranty_months` (optional) and `tier` (required) were both
          // omitted; the defaults fill them — a default satisfies `required`,
          // exactly as DML's `.default()` does on a non-nullable column.
          const row = await satelliteRow(created.data.product.id)
          expect(row.warranty_months).toEqual(12)
          expect(row.tier).toEqual("standard")
        })

        it("emits the default as a real column DEFAULT", async () => {
          const rows = await dbConnection.raw(
            `select column_default from information_schema.columns
             where table_name = 'product_custom_field' and column_name = 'warranty_months'`
          )
          expect(rows.rows[0].column_default).toContain("12")
        })

        it("lets an explicit null clear an optional defaulted field, but not a required one", async () => {
          const created = await api.post(
            "/admin/products",
            productPayload({ custom_fields: { brand: "NullVsDefault" } }),
            adminHeaders
          )
          const productId = created.data.product.id

          await api.post(
            `/admin/products/${productId}`,
            { custom_fields: { warranty_months: null } },
            adminHeaders
          )
          const row = await satelliteRow(productId)
          expect(row.warranty_months).toBeNull()

          const err = await api
            .post(`/admin/products/${productId}`, { custom_fields: { tier: null } }, adminHeaders)
            .catch((e) => e)
          expect(err.response.status).toEqual(400)
        })

        it("rejects unknown custom field keys", async () => {
          const err = await api
            .post(
              "/admin/products",
              productPayload({ custom_fields: { brand: "Acme", bogus_field: "x" } }),
              adminHeaders
            )
            .catch((e) => e)

          expect(err.response.status).toEqual(400)
        })

      })

      describe("update", () => {
        let productId: string

        beforeEach(async () => {
          const created = await api.post(
            "/admin/products",
            productPayload({ custom_fields: { brand: "Globex", manufacturer: "Globex GmbH" } }),
            adminHeaders
          )
          productId = created.data.product.id
        })

        it("updates a subset and keeps the rest", async () => {
          const res = await api.post(
            `/admin/products/${productId}`,
            { custom_fields: { manufacturer: "New Manu" } },
            adminHeaders
          )
          expect(res.status).toEqual(200)

          const row = await satelliteRow(productId)
          expect(row.brand).toEqual("Globex")
          expect(row.manufacturer).toEqual("New Manu")
        })

        it("clears an optional field with an explicit null", async () => {
          await api.post(
            `/admin/products/${productId}`,
            { custom_fields: { manufacturer: null } },
            adminHeaders
          )

          const row = await satelliteRow(productId)
          expect(row.manufacturer).toBeNull()
          expect(row.brand).toEqual("Globex")
        })

        it("refuses to clear a required field", async () => {
          const err = await api
            .post(
              `/admin/products/${productId}`,
              { custom_fields: { brand: null } },
              adminHeaders
            )
            .catch((e) => e)

          expect(err.response.status).toEqual(400)

          const row = await satelliteRow(productId)
          expect(row.brand).toEqual("Globex")
        })
      })

      describe("filtering", () => {
        it("narrows a list by a custom field", async () => {
          await api.post(
            "/admin/products",
            productPayload({ custom_fields: { brand: "FilterMe" } }),
            adminHeaders
          )
          await api.post(
            "/admin/products",
            productPayload({ custom_fields: { brand: "NotMe" } }),
            adminHeaders
          )

          const res = await api.get(
            `/admin/products?custom_fields[brand]=FilterMe`,
            adminHeaders
          )

          expect(res.status).toEqual(200)
          expect(res.data.products).toHaveLength(1)
          expect(res.data.products[0].custom_fields.brand).toEqual("FilterMe")
        })

        it("rejects filtering on an unknown custom field", async () => {
          const err = await api
            .get(`/admin/products?custom_fields[bogus]=x`, adminHeaders)
            .catch((e) => e)

          expect(err.response.status).toEqual(400)
        })

        it("supports operator filters over HTTP ($ilike, $in, $ne)", async () => {
          await api.post(
            "/admin/products",
            productPayload({ custom_fields: { brand: "OperAlpha" } }),
            adminHeaders
          )
          await api.post(
            "/admin/products",
            productPayload({ custom_fields: { brand: "OperBeta" } }),
            adminHeaders
          )

          const ilike = await api.get(
            `/admin/products?custom_fields[brand][$ilike]=${encodeURIComponent(
              "operal%"
            )}`,
            adminHeaders
          )
          expect(ilike.data.products).toHaveLength(1)
          expect(ilike.data.products[0].custom_fields.brand).toEqual("OperAlpha")

          const $in = await api.get(
            `/admin/products?custom_fields[brand][$in][0]=OperAlpha&custom_fields[brand][$in][1]=Nope`,
            adminHeaders
          )
          expect($in.data.products).toHaveLength(1)
          expect($in.data.products[0].custom_fields.brand).toEqual("OperAlpha")

          const ne = await api.get(
            `/admin/products?custom_fields[brand][$ne]=OperAlpha`,
            adminHeaders
          )
          expect(ne.data.products).toHaveLength(1)
          expect(ne.data.products[0].custom_fields.brand).toEqual("OperBeta")
        })

        it("matches null values with $is through query.graph", async () => {
          // HTTP query strings cannot express null (it arrives as the string
          // "null"), so null filtering is exercised at the query layer.
          const withManu = await api.post(
            "/admin/products",
            productPayload({ custom_fields: { brand: "NullProbe", manufacturer: "Set" } }),
            adminHeaders
          )
          const withoutManu = await api.post(
            "/admin/products",
            productPayload({ custom_fields: { brand: "NullProbe" } }),
            adminHeaders
          )

          const query: any = getContainer().resolve("query")
          const { data } = await query.graph({
            entity: "product",
            fields: ["id", "custom_fields.manufacturer"],
            filters: {
              custom_fields: { brand: "NullProbe", manufacturer: { $is: null } },
            },
          })

          expect(data).toHaveLength(1)
          expect(data[0].id).toEqual(withoutManu.data.product.id)
          expect(data[0].id).not.toEqual(withManu.data.product.id)
        })

        it("translates supported operators on the hydration path and rejects the rest", async () => {
          // `listSatellite` is what the joiner calls when it traverses into the
          // satellite; operator objects reaching it were previously handed to
          // knex verbatim and crashed as a driver error.
          const svc: any = getContainer().resolve("custom_fields")

          await api.post(
            "/admin/products",
            productPayload({ custom_fields: { brand: "HydrAlpha" } }),
            adminHeaders
          )

          const rows = await svc.listSatellite("product", {
            brand: { $ilike: "hydr%" },
          })
          expect(rows).toHaveLength(1)
          expect(rows[0].brand).toEqual("HydrAlpha")

          const nullRows = await svc.listSatellite("product", {
            manufacturer: { $is: null },
          })
          expect(nullRows.length).toBeGreaterThanOrEqual(1)

          await expect(
            svc.listSatellite("product", { brand: { $fulltext: "x" } })
          ).rejects.toThrow(/Unsupported filter operator "\$fulltext"/)
        })
      })

      describe("delete", () => {
        it("soft-deletes the satellite row in tandem with the product", async () => {
          const created = await api.post(
            "/admin/products",
            productPayload({ custom_fields: { brand: "DeleteMe" } }),
            adminHeaders
          )
          const productId = created.data.product.id

          await api.delete(`/admin/products/${productId}`, adminHeaders)

          const row = await satelliteRow(productId)
          expect(row.deleted_at).not.toBeNull()
          expect(row.brand).toEqual("DeleteMe")
        })
      })

      describe("workflow callers (non-HTTP)", () => {
        it("rejects a workflow create missing a required field, with nothing written", async () => {
          const { createProductsWorkflow } = require("@medusajs/core-flows")

          const title = "CF Workflow Missing Required"

          // Not `.rejects.toThrow`: after a revert the engine rejects with a
          // serialized (plain-object) error, which jest's toThrow refuses as
          // "did not throw".
          const err = await createProductsWorkflow(getContainer())
            .run({ input: { products: [productPayload({ title })] } })
            .then(
              () => null,
              (e: any) => e
            )

          expect(err).toBeTruthy()
          expect(err.message).toMatch(/brand/)

          const rows = await dbConnection.raw(
            `select count(*)::int as n from product where title = ?`,
            [title]
          )
          expect(rows.rows[0].n).toEqual(0)
        })

        it("compensates the satellite write when a later step fails", async () => {
          const { createProductsWorkflow } = require("@medusajs/core-flows")

          // Variants are created after the custom fields upsert, so an invalid
          // variant option fails the workflow once the satellite row exists —
          // exercising the snapshot/restore compensation, not the validate-first
          // rejection.
          const title = "CF Compensated Create"
          const err = await createProductsWorkflow(getContainer())
            .run({
              input: {
                products: [
                  productPayload({
                    title,
                    custom_fields: { brand: "CompBrand" },
                    variants: [
                      { title: "Bad", options: { NotAnOption: "zzz" } },
                    ],
                  }),
                ],
              },
            })
            .then(
              () => null,
              (e: any) => e
            )

          expect(err).toBeTruthy()

          const products = await dbConnection.raw(
            `select count(*)::int as n from product where title = ?`,
            [title]
          )
          const satellites = await dbConnection.raw(
            `select count(*)::int as n from product_custom_field where brand = 'CompBrand'`
          )
          expect(products.rows[0].n).toEqual(0)
          expect(satellites.rows[0].n).toEqual(0)
        })
      })

      describe("definitions endpoint", () => {
        it("lists the definitions in rank order with the full descriptor, without storage concerns", async () => {
          const response = await api.get("/admin/custom-fields", adminHeaders)

          expect(response.status).toEqual(200)

          // rank ascending (manufacturer: -1), ties by key.
          expect(response.data.definitions.map((d: any) => d.key)).toEqual([
            "manufacturer",
            "brand",
            "margin_pct",
            "sync_hash",
            "tier",
            "warranty_expiry",
            "warranty_months",
          ])

          const byKey = new Map(
            response.data.definitions.map((d: any) => [d.key, d])
          )

          expect(byKey.get("brand")).toEqual(
            expect.objectContaining({
              entity: "product",
              type: "text",
              required: true,
              readonly: false,
              restricted: false,
            })
          )
          expect(byKey.get("manufacturer")).toEqual(
            expect.objectContaining({ rank: -1 })
          )
          expect(byKey.get("warranty_months")).toEqual(
            expect.objectContaining({ min: 0, max: 120, default_value: 12 })
          )
          expect(byKey.get("warranty_expiry")).toEqual(
            expect.objectContaining({ type: "date", min: "2020-01-01" })
          )
          expect(byKey.get("margin_pct")).toEqual(
            expect.objectContaining({ type: "float", restricted: true })
          )
          expect(byKey.get("sync_hash")).toEqual(
            expect.objectContaining({ readonly: true })
          )

          // `indexed` is a storage concern with no UI meaning.
          for (const definition of response.data.definitions) {
            expect(definition).not.toHaveProperty("indexed")
          }
        })

        it("filters by entity", async () => {
          const product = await api.get(
            "/admin/custom-fields?entity=product",
            adminHeaders
          )
          expect(product.data.definitions).toHaveLength(7)

          const unknown = await api.get(
            "/admin/custom-fields?entity=nonexistent",
            adminHeaders
          )
          expect(unknown.status).toEqual(200)
          expect(unknown.data.definitions).toEqual([])
        })
      })

      describe("date fields", () => {
        it("persists a calendar date and returns it as the same ISO string", async () => {
          const created = await api.post(
            "/admin/products",
            productPayload({
              custom_fields: { brand: "Dated", warranty_expiry: "2024-06-01" },
            }),
            adminHeaders
          )
          expect(created.status).toEqual(200)

          const row = await satelliteRow(created.data.product.id)
          expect(row.warranty_expiry).toEqual("2024-06-01")

          const fetched = await api.get(
            `/admin/products/${created.data.product.id}?fields=id,*custom_fields`,
            adminHeaders
          )
          expect(fetched.data.product.custom_fields.warranty_expiry).toEqual(
            "2024-06-01"
          )
        })

        it("rejects a value carrying a time component rather than truncating it", async () => {
          const err = await api
            .post(
              "/admin/products",
              productPayload({
                custom_fields: {
                  brand: "Dated",
                  warranty_expiry: "2024-06-01T10:00:00Z",
                },
              }),
              adminHeaders
            )
            .catch((e) => e)

          expect(err.response.status).toEqual(400)
        })

        it("enforces the configured date bound", async () => {
          const err = await api
            .post(
              "/admin/products",
              productPayload({
                custom_fields: { brand: "Dated", warranty_expiry: "2019-12-31" },
              }),
              adminHeaders
            )
            .catch((e) => e)

          expect(err.response.status).toEqual(400)
          expect(JSON.stringify(err.response.data)).toContain("2020-01-01")
        })
      })

      describe("min/max", () => {
        it("rejects out-of-bounds values over HTTP", async () => {
          const over = await api
            .post(
              "/admin/products",
              productPayload({
                custom_fields: { brand: "Bounds", warranty_months: 200 },
              }),
              adminHeaders
            )
            .catch((e) => e)
          expect(over.response.status).toEqual(400)

          const under = await api
            .post(
              "/admin/products",
              productPayload({
                custom_fields: { brand: "Bounds", warranty_months: -1 },
              }),
              adminHeaders
            )
            .catch((e) => e)
          expect(under.response.status).toEqual(400)
        })

        it("enforces bounds for workflow callers too, with nothing written", async () => {
          const { createProductsWorkflow } = require("@medusajs/core-flows")

          const title = "CF Bounds Workflow"
          const err = await createProductsWorkflow(getContainer())
            .run({
              input: {
                products: [
                  productPayload({
                    title,
                    custom_fields: { brand: "Bounds", warranty_months: 200 },
                  }),
                ],
              },
            })
            .then(
              () => null,
              (e: any) => e
            )

          expect(err).toBeTruthy()
          expect(err.message).toMatch(/at most 120/)

          const rows = await dbConnection.raw(
            `select count(*)::int as n from product where title = ?`,
            [title]
          )
          expect(rows.rows[0].n).toEqual(0)
        })
      })

      describe("readonly", () => {
        it("rejects a readonly key in an HTTP write as unrecognized", async () => {
          const err = await api
            .post(
              "/admin/products",
              productPayload({
                custom_fields: { brand: "RO", sync_hash: "abc" },
              }),
              adminHeaders
            )
            .catch((e) => e)

          expect(err.response.status).toEqual(400)
          expect(JSON.stringify(err.response.data)).toContain("sync_hash")
        })

        it("lets workflow callers write readonly fields", async () => {
          const { createProductsWorkflow } = require("@medusajs/core-flows")

          const title = `CF RO Workflow ${Math.random().toString(36).slice(2)}`
          await createProductsWorkflow(getContainer()).run({
            input: {
              products: [
                productPayload({
                  title,
                  custom_fields: { brand: "RO", sync_hash: "written-by-code" },
                }),
              ],
            },
          })

          const rows = await dbConnection.raw(
            `select cf.sync_hash from product p
             join product_custom_field cf on cf.product_id = p.id
             where p.title = ?`,
            [title]
          )
          expect(rows.rows[0].sync_hash).toEqual("written-by-code")
        })
      })

      describe("store restriction", () => {
        const setupStoreProduct = async () => {
          const publishableKey = await generatePublishableKey(getContainer())
          const storeHeaders = generateStoreHeaders({ publishableKey })

          const product = (
            await api.post(
              "/admin/products",
              productPayload({
                status: "published",
                custom_fields: { brand: "StoreCo", margin_pct: 12.5 },
              }),
              adminHeaders
            )
          ).data.product

          const salesChannel = (
            await api.post(
              "/admin/sales-channels",
              { name: `cf-sc-${Math.random().toString(36).slice(2)}` },
              adminHeaders
            )
          ).data.sales_channel

          await api.post(
            `/admin/sales-channels/${salesChannel.id}/products`,
            { add: [product.id] },
            adminHeaders
          )

          await api.post(
            `/admin/api-keys/${publishableKey.id}/sales-channels`,
            { add: [salesChannel.id] },
            adminHeaders
          )

          return { storeHeaders, product, salesChannel }
        }

        it("expands a store wildcard to public fields only", async () => {
          const { storeHeaders, product } = await setupStoreProduct()

          const response = await api.get(
            `/store/products/${product.id}?fields=id,*custom_fields`,
            storeHeaders
          )

          expect(response.status).toEqual(200)
          const customFields = response.data.product.custom_fields
          expect(customFields.brand).toEqual("StoreCo")
          expect(customFields).not.toHaveProperty("margin_pct")
        })

        it("strips an explicit selector for a restricted field", async () => {
          const { storeHeaders, product } = await setupStoreProduct()

          const response = await api.get(
            `/store/products/${product.id}?fields=id,custom_fields.margin_pct`,
            storeHeaders
          )

          expect(response.status).toEqual(200)
          expect(response.data.product.custom_fields ?? {}).not.toHaveProperty(
            "margin_pct"
          )
        })

        it("filters by public fields on store, and fails on restricted ones like unknown keys", async () => {
          const { storeHeaders, salesChannel } = await setupStoreProduct()

          const byPublic = await api.get(
            `/store/products?sales_channel_id[]=${salesChannel.id}&custom_fields[brand]=StoreCo`,
            storeHeaders
          )
          expect(byPublic.status).toEqual(200)
          expect(byPublic.data.count).toBeGreaterThanOrEqual(1)

          const byRestricted = await api
            .get(
              `/store/products?sales_channel_id[]=${salesChannel.id}&custom_fields[margin_pct]=12.5`,
              storeHeaders
            )
            .catch((e) => e)
          expect(byRestricted.response.status).toEqual(400)
        })

        it("keeps restricted fields readable through the admin API", async () => {
          const { product } = await setupStoreProduct()

          const response = await api.get(
            `/admin/products/${product.id}?fields=id,*custom_fields`,
            adminHeaders
          )
          expect(response.data.product.custom_fields.margin_pct).toEqual(12.5)
        })
      })
    })
  },
})
