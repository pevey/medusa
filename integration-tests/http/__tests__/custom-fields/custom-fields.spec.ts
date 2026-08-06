import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import {
  adminHeaders,
  createAdminUser,
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
    })
  },
})
