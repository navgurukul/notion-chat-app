import dns from "dns";

if (typeof window === "undefined") {
  const originalLookup = dns.lookup;
  
  // @ts-ignore
  dns.lookup = function (hostname: string, options: any, callback: any) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    options = options || {};

    // Force IPv4 (family: 4) specifically for database and AI providers
    // to bypass slow parallel IPv6/IPv4 lookup timeouts in misconfigured networks.
    if (
      hostname &&
      (hostname.includes("neon.tech") ||
        hostname.includes("openai.com") ||
        hostname.includes("googleapis.com") ||
        hostname.includes("groq.com") ||
        hostname.includes("deepseek.com"))
    ) {
      options.family = 4;
      options.hints = (options.hints || 0) & ~dns.ADDRCONFIG;
    }
    return originalLookup(hostname, options, callback);
  };
}
