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

export default withRspack(nextConfig);
