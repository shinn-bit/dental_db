import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["html-to-docx", "pptxgenjs", "pdf-parse", "mammoth"],
};

export default nextConfig;
