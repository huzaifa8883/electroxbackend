const axios = require("axios");
const pool = require("../config/db");

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
  const saleRaw =
    product.sale_price !== undefined &&
    product.sale_price !== null &&
    String(product.sale_price).trim() !== ""
      ? Number(product.sale_price)
      : null;

  const regular =
    Number(product.regular_price) ||
    Number(product.selling_price) ||
    Number(product.price) ||
    0;

  // Inventory: selling_price often = sale; regular_price = original
  let sale = saleRaw;
  if ((sale === null || sale === 0) && Number(product.selling_price) > 0) {
    const sp = Number(product.selling_price);
    if (regular > 0 && sp < regular) sale = sp;
  }

  if (!regular && !sale) return null;

  const fmt = (n) => `Rs. ${Number(n).toLocaleString("en-PK")}`;

  // Sale chal rahi ho
  if (sale > 0 && regular > 0 && sale < regular) {
    const off = Math.round(((regular - sale) / regular) * 100);
    return {
      hasSale: true,
      regular: fmt(regular),
      sale: fmt(sale),
      off,
    };
  }

  const active = sale > 0 ? sale : regular;
  return {
    hasSale: false,
    regular: fmt(active),
    sale: null,
    off: 0,
  };
}

function toAbsolute(src) {
  if (!src) return null;
  let url = String(src).trim();
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  const base = (process.env.PUBLIC_API_URL || process.env.WEBSITE_URL || "").replace(
    /\/$/,
    ""
  );
  if (!url.startsWith("/")) url = "/" + url;
  return base ? base + url : null;
}

function getImageUrl(product) {
  if (Array.isArray(product.images) && product.images.length) {
    const first = product.images[0];
    if (typeof first === "string") return toAbsolute(first);
    return toAbsolute(first.src || first.url || null);
  }
  if (product.image_url) return toAbsolute(product.image_url);
  return null;
}

function buildCaption(product) {
  const title = (product.name || "New Arrival").trim();
  const price = formatPrice(product);
  const short = stripHtml(
    product.short_description ||
      product.meta_description ||
      product.description ||
      ""
  )
    .slice(0, 200)
    .trim();
  const link = product.permalink || process.env.WEBSITE_URL || "";

  // ─── Title ───
  let caption = `✨ ${title}\n`;
  caption += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // ─── Price block ───
  if (price) {
    if (price.hasSale) {
      caption += `💥 SPECIAL OFFER\n`;
      caption += `~~${price.regular}~~  ❌\n`;
      caption += `🔥 Now only ${price.sale}\n`;
      caption += `✅ ${price.off}% OFF — Limited time!\n\n`;
    } else {
      caption += `💰 Price: ${price.regular}\n\n`;
    }
  } else {
    caption += `💰 Price on request\n\n`;
  }

  // ─── Short description ───
  if (short) {
    caption += `📝 ${short}\n\n`;
  }

  // ─── CTA + link ───
  if (link) {
    caption += `🛒 Order now:\n${link}\n\n`;
  }

  caption += `━━━━━━━━━━━━━━━━━━━━\n`;
  caption += `📦 Fast delivery  |  ✅ Genuine product\n`;
  caption += `#Electrox #Electronics #NewArrival #Sale`;

  return caption;
}
async function saveFacebookPostId(productId, postId) {
  if (!productId || !postId) return;
  try {
    await pool.query(
      `UPDATE products SET facebook_post_id = $1 WHERE id = $2`,
      [String(postId), productId]
    );
    console.log(`[Social] saved facebook_post_id=${postId} product=${productId}`);
  } catch (e) {
    console.warn("[Social] could not save facebook_post_id:", e.message);
  }
}

/** CREATE new Facebook post — and save post id on product */
async function postToFacebook(product) {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) {
    console.warn("[Social] FB credentials missing");
    return null;
  }

  // Safety: agar pehle se post hai to naya mat banao
  if (product.facebook_post_id) {
    console.log("[Social] facebook_post_id already set — skip NEW post, use update instead");
    return updateFacebookPost(product);
  }

  const caption = buildCaption(product);
  const imageUrl = getImageUrl(product);

  try {
    let postId = null;
    let data = null;

    if (imageUrl) {
      const res = await axios.post(
        `https://graph.facebook.com/v19.0/${pageId}/photos`,
        { url: imageUrl, caption, access_token: token },
        { timeout: 30000 }
      );
      data = res.data;
      // photos API returns post_id for the Page feed post
      postId = data.post_id || data.id;
    } else {
      const res = await axios.post(
        `https://graph.facebook.com/v19.0/${pageId}/feed`,
        { message: caption, access_token: token },
        { timeout: 30000 }
      );
      data = res.data;
      postId = data.id;
    }

    console.log(`[Social] ✅ Facebook NEW post → ${postId}`);
    if (product.id && postId) {
      await saveFacebookPostId(product.id, postId);
    }
    return { ...data, post_id: postId };
  } catch (err) {
    console.error("[Social] ❌ Facebook create failed:", err.response?.data || err.message);
    return null;
  }
}

/** UPDATE existing Facebook post message only — NO new post */
async function updateFacebookPost(product) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  const postId = product.facebook_post_id;
  if (!token) {
    console.warn("[Social] FB token missing — skip update");
    return null;
  }
  if (!postId) {
    console.log(
      `[Social] No facebook_post_id for ${product.id || product.sku} — skip (will not create new post on update)`
    );
    return null;
  }

  const caption = buildCaption(product);
  try {
    const { data } = await axios.post(
      `https://graph.facebook.com/v19.0/${postId}`,
      { message: caption, access_token: token },
      { timeout: 30000 }
    );
    console.log(`[Social] ✅ Facebook UPDATED → ${postId}`);
    return data;
  } catch (err) {
    console.error("[Social] ❌ Facebook update failed:", err.response?.data || err.message);
    return null;
  }
}

async function postToInstagram(product) {
  const igAccountId = process.env.IG_ACCOUNT_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!igAccountId || !token) return null;

  const imageUrl = getImageUrl(product);
  if (!imageUrl) return null;

  const caption = buildCaption(product);
  try {
    const { data: container } = await axios.post(
      `https://graph.facebook.com/v19.0/${igAccountId}/media`,
      { image_url: imageUrl, caption, access_token: token },
      { timeout: 30000 }
    );
    if (!container.id) throw new Error("No IG container id");
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

/** New product only */
async function postProductToSocial(product) {
  if (product.facebook_post_id) {
    return updateProductOnSocial(product);
  }
  const results = await Promise.allSettled([
    postToFacebook(product),
    postToInstagram(product),
  ]);
  return {
    facebook: results[0].status === "fulfilled" ? results[0].value : null,
    instagram: results[1].status === "fulfilled" ? results[1].value : null,
  };
}

/** Update only — never creates a new FB post */
async function updateProductOnSocial(product) {
  const fb = await updateFacebookPost(product);
  return { facebook: fb, instagram: null };
}

module.exports = {
  buildCaption,
  postToFacebook,
  postToInstagram,
  postProductToSocial,
  updateFacebookPost,
  updateProductOnSocial,
  getImageUrl,
};
