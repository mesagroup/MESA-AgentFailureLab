export interface Product {
  product_id: string;
  sku: string;
  name: string;
  description: string;
  price_usd: number;
  stock: number;
}

/** Small catalog shared by tasks T1–T5. `product_id` and `sku` are the same value. */
export const SEED_PRODUCTS: readonly Product[] = [
  {
    product_id: "SKU-MUG-01",
    sku: "SKU-MUG-01",
    name: "Ceramic Mug",
    description: "12oz stoneware mug, speckled glaze.",
    price_usd: 12,
    stock: 20,
  },
  {
    product_id: "SKU-TEE-02",
    sku: "SKU-TEE-02",
    name: "Cotton T-Shirt",
    description: "Unisex tee, washed black, size M.",
    price_usd: 25,
    stock: 15,
  },
  {
    product_id: "SKU-CAP-03",
    sku: "SKU-CAP-03",
    name: "Canvas Cap",
    description: "Unstructured cap, natural canvas.",
    price_usd: 18,
    stock: 10,
  },
  {
    product_id: "SKU-BAG-04",
    sku: "SKU-BAG-04",
    name: "Tote Bag",
    description: "Heavy canvas tote, natural.",
    price_usd: 32,
    stock: 8,
  },
  {
    product_id: "SKU-NOTE-05",
    sku: "SKU-NOTE-05",
    name: "Notebook",
    description: "A5 ruled notebook, 80 pages.",
    price_usd: 9.5,
    stock: 30,
  },
];

export function cloneSeedProducts(): Map<string, Product> {
  const products = new Map<string, Product>();
  for (const product of SEED_PRODUCTS) {
    products.set(product.product_id, { ...product });
  }
  return products;
}
