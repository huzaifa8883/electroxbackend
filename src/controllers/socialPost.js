/**
 * Facebook Page + Instagram product posts
 *
 * .env required:
 *   FB_PAGE_ID=...
 *   FB_PAGE_ACCESS_TOKEN=...   (Page token with pages_manage_posts, instagram_basic, instagram_content_publish)
 *   IG_ACCOUNT_ID=...          (Instagram Business account id linked to the Page)
 *   WEBSITE_URL=https://electrox.pk
 *   PUBLIC_API_URL=https://electroxbackend.work.gd
 */
const axios = require("axios");

function stripHtml(html = "") {
  return String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function formatPrice(product) {
  const sale =
    product.sale_price !== undefined && product.sale_price !== null && String(product.sale_price).trim() !== ""
      ? Number(product.sale_price)
      : null;
  const regular =
    Number(product.regular_price) ||
    Number(product.selling_price) ||
    Number(product.price) ||
    0;
  const active = sale && sale > 0 ? sale : regular;

  if (!active) return "Price on request";

  if (sale && sale > 0 && regular > sale) {
    return `~~Rs. ${regular.toLocaleString()}~~  →  🔥 Rs. ${sale.toLocaleString()}`;
  }
  return `Rs. ${Number(active).toLocaleString()}`;
}

function getImageUrl(product) {
  // Woo shape: images: [{ src }]
  if (Array.isArray(product.images) && product.images.length) {
    const first = product.images[0];
    if (typeof first === "string") return toAbsolute(first);
    return toAbsolute(first.src || first.url || null);
  }
  // Inventory shape
  if (product.image_url) return toAbsolute(product.image_url);
  return null;
}

function toAbsolute(src) {
  if (!src) return null;
  let url = String(src).trim();
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  const base = (process.env.PUBLIC_API_URL || process.env.WEBSITE_URL || "").replace(/\/$/, "");
  if (!url.startsWith("/")) url = "/" + url;
  return base ? base + url : null;
}

function buildCaption(product) {
  const title = (product.name || "New Arrival").trim();
  const priceLine = formatPrice(product);
  const short =
    stripHtml(product.short_description || product.meta_description || product.description || "")
      .slice(0, 220)
      .trim();
  const link =
    product.permalink ||
    (process.env.WEBSITE_URL ? `${process.env.WEBSITE_URL.replace(/\/$/, "")}/?s=${encodeURIComponent(product.sku || title)}` : "");

  let caption = "";
  caption += `✨ ${title}\n\n`;
  caption += `💰 ${priceLine}\n\n`;
  if (short) caption += `📝 ${short}\n\n`;
  if (product.sku) caption += `🔖 SKU: ${product.sku}\n\n`;
  if (link) caption += `🛒 Order now:\n${link}\n\n`;
  caption += `——————————————\n`;
  caption += `📦 Nationwide delivery | ⚡ Genuine products\n`;
  caption += `#Electrox #Electronics #NewArrival #Pakistan #OnlineShopping`;

  return caption;
}

async function postToFacebook(product) {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;

  if (!pageId || !token) {
    console.warn("[Social] Facebook credentials missing – skip FB post");
    return null;
  }

  const caption = buildCaption(product);
  const imageUrl = getImageUrl(product);

  try {
    if (imageUrl) {
      const { data } = await axios.post(
        `https://graph.facebook.com/v19.0/${pageId}/photos`,
        { url: imageUrl, caption, access_token: token },
        { timeout: 30000 }
      );
      console.log(`[Social] ✅ Facebook photo post → ${data.id || data.post_id}`);
      return data;
    }

    // Text-only fallback
    const { data } = await axios.post(
      `https://graph.facebook.com/v19.0/${pageId}/feed`,
      { message: caption, access_token: token },
      { timeout: 30000 }
    );
    console.log(`[Social] ✅ Facebook text post → ${data.id}`);
    return data;
  } catch (err) {
    console.error("[Social] ❌ Facebook failed:", err.response?.data || err.message);
    return null;
  }
}

async function postToInstagram(product) {
  const igAccountId = process.env.IG_ACCOUNT_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;

  if (!igAccountId || !token) {
    console.warn("[Social] Instagram credentials missing – skip IG post");
    return null;
  }

  const imageUrl = getImageUrl(product);
  if (!imageUrl) {
    console.warn("[Social] Instagram needs a public image URL – skip");
    return null;
  }

  const caption = buildCaption(product);

  try {
    const { data: container } = await axios.post(
      `https://graph.facebook.com/v19.0/${igAccountId}/media`,
      { image_url: imageUrl, caption, access_token: token },
      { timeout: 30000 }
    );

    if (!container.id) throw new Error("No IG container id");

    // Small delay helps IG process the container
    await new Promise((r) => setTimeout(r, 3000));

    const { data: published } = await axios.post(
      `https://graph.facebook.com/v19.0/${igAccountId}/media_publish`,
      { creation_id: container.id, access_token: token },
      { timeout: 30000 }
    );

    console.log(`[Social] ✅ Instagram post → ${published.id}`);
    return published;
  } catch (err) {
    console.error("[Social] ❌ Instagram failed:", err.response?.data || err.message);
    return null;
  }
}

/** Post to both platforms (non-throwing) */
async function postProductToSocial(product) {
  const results = await Promise.allSettled([
    postToFacebook(product),
    postToInstagram(product),
  ]);
  return {
    facebook: results[0].status === "fulfilled" ? results[0].value : null,
    instagram: results[1].status === "fulfilled" ? results[1].value : null,
  };
}

module.exports = {
  buildCaption,
  postToFacebook,
  postToInstagram,
  postProductToSocial,
  getImageUrl,
};
