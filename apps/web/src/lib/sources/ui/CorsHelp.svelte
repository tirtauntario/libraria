<script lang="ts">
  let { open = false }: { open?: boolean } = $props();
  const origin = typeof location !== 'undefined' ? location.origin : 'https://your-libraria-app';
</script>

<details class="help" {open}>
  <summary>How to allow Libraria on your server (CORS)</summary>
  <p>
    Libraria talks to your WebDAV server straight from the browser. The server has to allow this app’s origin,
    <code>{origin}</code>, to send <code>PROPFIND</code> and <code>GET</code> with the <code>Authorization</code>,
    <code>Depth</code> and <code>Range</code> headers, and answer the <code>OPTIONS</code> preflight without asking for a password.
  </p>
  <h4>Nextcloud / ownCloud</h4>
  <p>
    Use <code>https://your.host/remote.php/dav/files/USERNAME/</code> with an app password. Nextcloud does not send CORS
    headers for WebDAV by itself; add them in the web server in front of it (below), or install an app such as “WebAppPassword”
    and add this origin to its allowed list.
  </p>
  <h4>Apache (mod_headers)</h4>
  <pre>Header always set Access-Control-Allow-Origin "{origin}"
Header always set Access-Control-Allow-Methods "GET, HEAD, OPTIONS, PROPFIND"
Header always set Access-Control-Allow-Headers "Authorization, Depth, Content-Type, Range, If-Range"
Header always set Access-Control-Expose-Headers "ETag, Content-Length, Content-Range, Accept-Ranges"
RewriteEngine On
RewriteCond %&#123;REQUEST_METHOD&#125; OPTIONS
RewriteRule ^(.*)$ $1 [R=204,L]</pre>
  <h4>nginx</h4>
  <pre>add_header Access-Control-Allow-Origin "{origin}" always;
add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS, PROPFIND" always;
add_header Access-Control-Allow-Headers "Authorization, Depth, Content-Type, Range, If-Range" always;
add_header Access-Control-Expose-Headers "ETag, Content-Length, Content-Range, Accept-Ranges" always;
if ($request_method = OPTIONS) &#123; return 204; &#125;</pre>
  <p class="subtle">
    An HTTPS page cannot reach a plain <code>http://</code> server (mixed content), and self-signed certificates must be trusted
    by the browser first: open the server address in a tab once.
  </p>
</details>

<style>
  .help {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 12px;
    font-size: 13.5px;
    background: var(--surface);
  }
  summary {
    cursor: pointer;
    font-weight: 600;
    color: var(--accent);
    padding: 4px 0;
  }
  p,
  h4 {
    margin: 8px 0 0;
  }
  h4 {
    font-size: 13px;
  }
  pre {
    margin: 6px 0 0;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-family: var(--font-mono);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    word-break: break-all;
  }
</style>
