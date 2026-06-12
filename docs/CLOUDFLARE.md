# Cloudflare CDN Setup for Backblaze B2 Mirror

Serves a public B2 bucket through Cloudflare's CDN with **zero egress fees**
(Backblaze + Cloudflare Bandwidth Alliance).

## Prerequisites

- A domain managed by Cloudflare (Free plan works)
- A Backblaze B2 account with a **public** bucket already populated with files
- Your bucket's **friendly URL** hostname (e.g. `f000.backblazeb2.com`)

---

## Step 1: Add DNS CNAME Record

1. In Cloudflare dashboard → **DNS** → **Records** → **Add record**
2. Type: **CNAME**
3. Name: your subdomain (e.g. `formulae` for `formulae.yourdomain.com`)
4. Target: your B2 endpoint hostname (e.g. `f000.backblazeb2.com`)
5. Proxy status: **Proxied** (orange cloud, not grey)

---

## Step 2: Set SSL/TLS to Full (Strict)

B2 only serves HTTPS. Cloudflare must connect to B2 over HTTPS.

1. **SSL/TLS** → **Overview** → **Configure**
2. Select **Full (Strict)**

---

## Step 3: Create URL Rewrite Transform Rule

Without this, anyone can use your domain to access *any* public B2 bucket.
The rule scopes requests to only your bucket.

1. **Rules** → **Transform Rules** → **Create rule** → **Rewrite URL**
2. **When incoming requests match:**
   - Field: **Hostname**
   - Operator: **equals**
   - Value: `formulae.yourdomain.com` (your full subdomain)
3. **Rewrite to…** → **Path** → **Dynamic**
   - Value: `concat("/file/YOUR_BUCKET_NAME", http.request.uri.path)`
   - (Replace `YOUR_BUCKET_NAME` with your actual B2 bucket name)
4. **Deploy**

---

## Step 4: Rewrite Root to Index (Home Page)

So `https://formulae.yourdomain.com/` serves `index.html` from B2.

1. **Rules** → **Transform Rules** → **Create rule** → **Rewrite URL**
2. Rule name: `Rewrite root to index`
3. **When incoming requests match:**
   - Custom filter expression
   - Field: **URI Full**, Operator: **equals**
   - Value: `https://formulae.yourdomain.com/`
4. **Rewrite to…** → **Path** → **Static**
   - Value: `file/YOUR_BUCKET_NAME/index.html`
5. **Place at**: **First** (this rule must run before the bucket-scoping rule)
6. **Deploy**

---

## Step 5: Configure Caching

### 5a. Set B2 Bucket Cache Headers

In Backblaze B2 web console:
1. Navigate to your bucket → **Bucket Settings**
2. In **Bucket Info**, add:
   ```json
   {"cache-control":"max-age=7200"}
   ```
   (Caches for 2 hours — adjust `max-age` as needed)
3. **Update Bucket**

### 5b. (Optional) Cloudflare Cache Rules

For finer control, use Cloudflare **Cache Rules**:
1. **Caching** → **Cache Rules** → **Create rule**
2. Match: `formulae.yourdomain.com/*`
3. **Edge TTL** → Override to your preference
4. **Browser TTL** → Override to your preference

---

## Step 6: Verify

```bash
# Check that files are served through Cloudflare
curl -I https://formulae.yourdomain.com/index.html

# Look for these headers:
#   cf-cache-status: HIT      (cached by Cloudflare)
#   x-cache-status: ...       (from B2)
#   server: cloudflare        (proxied through Cloudflare)
```

---

## Reference

- [Backblaze: Deliver Public B2 Content Through Cloudflare CDN](https://www.backblaze.com/docs/cloud-storage-deliver-public-backblaze-b2-content-through-cloudflare-cdn)
- [Fix B2 and Cloudflare CDN Caching](https://www.ansonlichtfuss.com/blog/free-cloudflare-cdn-with-backblaze-b2-bucket-storage-caching)
- [Cloudflare Transform Rules](https://developers.cloudflare.com/rules/transform/)
