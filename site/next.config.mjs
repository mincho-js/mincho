import nextra from "nextra";
import withRspack from "next-rspack";

const withNextra = nextra({
  contentDirBasePath: "/docs"
});

const nextConfig = withNextra({
  reactStrictMode: true,
  output: "export",
  basePath: "/mincho",
  trailingSlash: true,
  images: {
    unoptimized: true
  }
});

export default withRspack(nextConfig);
