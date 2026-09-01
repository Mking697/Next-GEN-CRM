import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hostinger runs `npm start` -> node .next/standalone/server.js
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  // pg + the Prisma driver adapter must stay real Node modules, never bundled.
  serverExternalPackages: ["pg", "@prisma/adapter-pg"],

  // pdfkit, which @react-pdf renders through, loads its built-in font metrics
  // with a computed require: `require('#standard-fonts/Helvetica')`. Next's
  // file tracer cannot follow that, so the files are silently left out of the
  // standalone bundle and every PDF render fails at runtime with
  // MODULE_NOT_FOUND. 182KB, force-included.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/pdfkit/js/standard-fonts/**"],
  },
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
