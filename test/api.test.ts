import { afterEach, describe, expect, it } from "bun:test";

import {
  addConsumedItems,
  createProduct,
  deleteConsumedItems,
  getNutrientDaily,
  getProduct,
  login,
  refresh,
  searchProducts,
  setWaterIntake,
  YazioApiError,
  YazioShapeError,
} from "../src/yazio/api";

const realFetch = globalThis.fetch;

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

const calls: Call[] = [];

/** Answer every request with `body`, recording what was actually sent. */
function stubFetch(body: unknown, status = 200) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    });
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

const token = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  token_type: "bearer",
  expires_in: 172_800,
};

describe("login", () => {
  it("sends the password grant with the app's own client credentials", async () => {
    stubFetch(token);
    const issued = await login("someone@example.com", "hunter2");

    const [call] = calls;
    const form = new URLSearchParams(call.body);
    expect(call.url).toBe("https://yzapi.yazio.com/v20/oauth/token");
    expect(call.method).toBe("POST");
    expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(form.get("grant_type")).toBe("password");
    expect(form.get("username")).toBe("someone@example.com");
    expect(form.get("password")).toBe("hunter2");
    expect(form.get("client_id")).toBeTruthy();
    expect(form.get("client_secret")).toBeTruthy();

    expect(issued.accessToken).toBe("access-1");
    expect(issued.refreshToken).toBe("refresh-1");
    expect(issued.expiresAt).toBeGreaterThan(Date.now());
  });

  it("reports Yazio's status when the credentials are refused", async () => {
    stubFetch({ error: "invalid_grant" }, 401);
    const failure = await login("someone@example.com", "wrong").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(YazioApiError);
    expect((failure as YazioApiError).status).toBe(401);
  });
});

describe("refresh", () => {
  it("uses Yazio's own refresh grant, without the password", async () => {
    stubFetch(token);
    await refresh("refresh-1");

    const form = new URLSearchParams(calls[0].body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-1");
    expect(form.get("password")).toBeNull();
  });
});

describe("reads", () => {
  it("passes the bearer token and keeps unknown fields harmless", async () => {
    stubFetch({
      name: "Oatmeal",
      producer: null,
      base_unit: "g",
      is_verified: true,
      nutrients: { "energy.energy": 3.7, "vitamin.new": null },
      servings: [{ serving: "cup", amount: 80 }],
      something_yazio_added_later: { nested: true },
    });

    const product = await getProduct("access-1", "1a2b3c");

    expect(calls[0].headers.get("authorization")).toBe("Bearer access-1");
    expect(product?.nutrients).toEqual({ "energy.energy": 3.7 });
    expect(product?.servings).toEqual([{ serving: "cup", amount: 80 }]);
  });

  it("resolves to null for a product Yazio does not have", async () => {
    stubFetch(null, 404);
    expect(await getProduct("access-1", "missing")).toBeNull();
  });

  it("rejects a response it cannot read at all", async () => {
    stubFetch({ nutrients: "not a map" });
    const failure = await getProduct("access-1", "1a2b3c").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(YazioShapeError);
  });

  it("sends the query, the country and the sex the endpoint insists on", async () => {
    stubFetch([]);
    await searchProducts("access-1", { query: "творог 5%", country: "RU", sex: "female" });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v20/products/search");
    expect(url.searchParams.get("query")).toBe("творог 5%");
    expect(url.searchParams.get("countries")).toBe("RU");
    expect(url.searchParams.get("sex")).toBe("female");
  });
});

describe("diary writes", () => {
  const item = {
    id: "entry-1",
    product_id: "product-1",
    date: "2026-07-30",
    daytime: "snack" as const,
    amount: 111,
    serving: "gram",
    serving_quantity: 111,
  };

  it("writes a whole meal in one request", async () => {
    stubFetch(undefined);
    await addConsumedItems("access-1", { products: [item, { ...item, id: "entry-2" }] });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body)).toEqual({
      products: [item, { ...item, id: "entry-2" }],
      recipe_portions: [],
      simple_products: [],
    });
  });

  it("deletes several entries in one request", async () => {
    stubFetch(undefined);
    await deleteConsumedItems("access-1", ["entry-1", "entry-2"]);

    expect(calls[0].method).toBe("DELETE");
    expect(JSON.parse(calls[0].body)).toEqual(["entry-1", "entry-2"]);
  });

  it("writes a quick-added item with its totals and no product", async () => {
    stubFetch(undefined);
    const quick = {
      id: "quick-1",
      date: "2026-07-30 12:00:00",
      daytime: "lunch" as const,
      name: "canteen soup",
      nutrients: { "energy.energy": 320, "nutrient.protein": 12 },
    };
    await addConsumedItems("access-1", { simpleProducts: [quick] });

    expect(JSON.parse(calls[0].body)).toEqual({
      products: [],
      simple_products: [quick],
      recipe_portions: [],
    });
  });
});

describe("own products", () => {
  it("posts the product with nutrients per base unit", async () => {
    stubFetch(undefined);
    const product = {
      id: "product-1",
      name: "grandma's syrniki",
      category: "miscellaneous",
      base_unit: "g",
      is_private: true,
      nutrients: { "energy.energy": 1.98, "nutrient.carb": 0.2 },
      servings: [{ serving: "piece", amount: 70 }],
    };
    await createProduct("access-1", product);

    expect(new URL(calls[0].url).pathname).toBe("/v20/user/products");
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body)).toEqual(product);
  });
});

describe("water and nutrient history", () => {
  it("sets the day's water total at a fixed time of day", async () => {
    stubFetch(undefined);
    await setWaterIntake("access-1", "2026-07-30", 500);

    expect(new URL(calls[0].url).pathname).toBe("/v20/user/water-intake");
    // An array, not a bare object: Yazio accepts the object and ignores it.
    expect(JSON.parse(calls[0].body)).toEqual([{ date: "2026-07-30 12:00:00", water_intake: 500 }]);
  });

  it("asks for one nutrient over a range", async () => {
    stubFetch({ "2026-07-30": 12.5 });
    const days = await getNutrientDaily(
      "access-1",
      "nutrient.dietaryfiber",
      "2026-07-24",
      "2026-07-30",
    );

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v20/user/consumed-items/specific-nutrient-daily");
    expect(url.searchParams.get("nutrient")).toBe("nutrient.dietaryfiber");
    expect(url.searchParams.get("start")).toBe("2026-07-24");
    expect(days).toEqual({ "2026-07-30": 12.5 });
  });
});

describe("the Android user agent", () => {
  it("goes on writes, which Yazio refuses without it", async () => {
    stubFetch(undefined);
    await deleteConsumedItems("access-1", ["entry-1"]);

    expect(calls[0].headers.get("user-agent")).toContain("com.yazio.android");
  });

  it("goes on reads too, so both look like the same client", async () => {
    stubFetch({ name: "x", base_unit: "g", nutrients: {} });
    await getProduct("access-1", "1a2b3c");

    expect(calls[0].headers.get("user-agent")).toContain("com.yazio.android");
  });
});

describe("failures", () => {
  it("carries what Yazio actually said into the error", async () => {
    stubFetch(
      [{ property_path: "nutrients", message: "Required nutrient types are missing." }],
      400,
    );
    const failure = (await createProduct("access-1", {
      id: "product-1",
      name: "nameless",
      category: "miscellaneous",
      base_unit: "g",
      is_private: true,
      nutrients: {},
      servings: [],
    }).catch((error: unknown) => error)) as YazioApiError;

    expect(failure).toBeInstanceOf(YazioApiError);
    expect(failure.status).toBe(400);
    expect(failure.body).toContain("Required nutrient types are missing.");
    expect(failure.message).toContain("Required nutrient types are missing.");
  });

  it("truncates a long failure instead of passing on a whole page", async () => {
    stubFetch("x".repeat(2000), 500);
    const failure = (await getProduct("access-1", "1a2b3c").catch(
      (error: unknown) => error,
    )) as YazioApiError;

    expect(failure.body.length).toBe(500);
  });

  it("names the field that moved when the shape changes", async () => {
    stubFetch({ nutrients: "not a map" });
    const failure = (await getProduct("access-1", "1a2b3c").catch(
      (error: unknown) => error,
    )) as YazioShapeError;

    expect(failure.message).toContain("nutrients");
  });
});
