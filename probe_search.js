const searchProvider = require("./src/providers/searchProvider");

async function main() {
  for (const k of ["Shopify stores", "Shopify development agencies India", "Shopify agency India", "Shopify store"]) {
    console.log(`\n--- Testing keyword: "${k}" ---`);
    try {
      const results = await searchProvider.searchShopifyStores(k, "India", 30);
      console.log(`Found ${results.length} results:`);
      results.slice(0, 5).forEach((r, i) => {
        console.log(`  ${i+1}. ${r.url} - ${r.title}`);
      });
    } catch (e) {
      console.error("Error:", e.message);
    }
  }
}

main();