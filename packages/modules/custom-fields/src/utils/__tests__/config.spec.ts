import { resolveDefinitions } from "../config"

const options = (fields: Record<string, any>) => ({ fields: { brand: fields } })

describe("resolveDefinitions", () => {
  it("resolves definitions with defaults applied and keys sorted", () => {
    const byEntity = resolveDefinitions(
      options({
        rating: { type: "float" },
        country: { type: "text", required: true },
      })
    )

    const definitions = byEntity.get("brand")!
    expect(definitions.map((d) => d.key)).toEqual(["country", "rating"])
    expect(definitions[0]).toEqual(
      expect.objectContaining({
        entity: "brand",
        key: "country",
        required: true,
        indexed: false,
      })
    )
  })

  it("rejects a reserved key", () => {
    expect(() =>
      resolveDefinitions(options({ deleted_at: { type: "text" } }))
    ).toThrow(/reserved key/)
  })

  it("rejects an unknown type", () => {
    expect(() =>
      resolveDefinitions(options({ tier: { type: "varchar" } }))
    ).toThrow(/unknown type/)
  })

  it("requires choices on enums and rejects them elsewhere", () => {
    expect(() => resolveDefinitions(options({ tier: { type: "enum" } }))).toThrow(
      /must declare "choices"/
    )
    expect(() =>
      resolveDefinitions(options({ name: { type: "text", choices: ["a"] } }))
    ).toThrow(/declares "choices" but is not an enum/)
  })

  describe("default_value", () => {
    it("accepts a type-valid default", () => {
      const byEntity = resolveDefinitions(
        options({
          warranty_months: { type: "number", default_value: 12 },
          tier: {
            type: "enum",
            choices: ["standard", "premium"],
            required: true,
            default_value: "standard",
          },
        })
      )

      const byKey = new Map(
        byEntity.get("brand")!.map((d) => [d.key, d.default_value])
      )
      expect(byKey.get("warranty_months")).toEqual(12)
      expect(byKey.get("tier")).toEqual("standard")
    })

    it("rejects a default that is not valid for the type, at boot", () => {
      expect(() =>
        resolveDefinitions(
          options({ warranty_months: { type: "number", default_value: "abc" } })
        )
      ).toThrow(/default_value that is not a valid "number"/)

      expect(() =>
        resolveDefinitions(
          options({ warranty_months: { type: "number", default_value: 1.5 } })
        )
      ).toThrow(/default_value/)
    })

    it("rejects an enum default outside its choices", () => {
      expect(() =>
        resolveDefinitions(
          options({
            tier: {
              type: "enum",
              choices: ["standard", "premium"],
              default_value: "gold",
            },
          })
        )
      ).toThrow(/default_value that is not a valid "enum"/)
    })
  })
})
