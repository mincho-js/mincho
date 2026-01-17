import nextra from "nextra";

const withNextra = nextra({
  contentDirBasePath: "/docs"
});

export default withNextra({
  reactStrictMode: true,
  output: "export",
  basePath: "/mincho",
  trailingSlash: true,
  images: {
    unoptimized: true
  }
});
