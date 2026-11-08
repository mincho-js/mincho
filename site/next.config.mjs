import nextra from "nextra";
import withRspack from "next-rspack";
import { basePath } from "./site.config.mjs";

const withNextra = nextra({
  contentDirBasePath: "/docs"
});

const nextConfig = withNextra({
  reactStrictMode: true,
  output: "export",
  basePath,
  trailingSlash: true,
  typescript: {
    tsconfigPath: "tsconfig.app.json"
  },
  images: {
    unoptimized: true
  }
});

// Webpack keeps documentation compilation stable in the Yarn PnP dev server.
export default process.env.NODE_ENV === "development"
  ? nextConfig
  : withRspack(nextConfig);
