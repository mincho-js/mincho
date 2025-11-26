import nextra from "nextra";

const withNextra = nextra({
  // Nextra options
});

export default withNextra({
  reactStrictMode: true,
  i18n: {
    locales: ["en", "ko"],
    defaultLocale: "en"
  }
});
