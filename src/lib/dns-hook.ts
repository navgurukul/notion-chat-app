import dns from "dns";

if (typeof window === "undefined") {
  try {
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
  } catch (e) {
    // Ignore if environment restricts custom DNS servers
  }
  if (typeof dns.setDefaultResultOrder === "function") {
    dns.setDefaultResultOrder("ipv4first");
  }
  const originalLookup = dns.lookup;
  
  // @ts-ignore
  dns.lookup = function (hostname: string, options: any, callback: any) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    options = options || {};

    // Force IPv4 via public DNS for database and AI providers
    // to bypass slow/broken local system DNS lookups in sandboxed networks.
    if (
      hostname &&
      (hostname.includes("neon.tech") || hostname.includes("openai.com"))
    ) {
      dns.resolve4(hostname, (err, addrs) => {
        if (!err && addrs && addrs.length > 0) {
          if (options && options.all) {
            return callback(
              null,
              addrs.map((a) => ({ address: a, family: 4 })),
            );
          }
          return callback(null, addrs[0], 4);
        }
        return originalLookup(hostname, options, callback);
      });
      return;
    }
    return originalLookup(hostname, options, callback);
  };
}
