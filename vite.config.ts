import { defineConfig } from "vite";

const contentSecurityPolicy = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self' data:",
	"media-src 'self' blob:",
	"worker-src 'self' blob:",
	"connect-src 'self'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
].join("; ");

export default defineConfig({
	base: "/tools/VodSync/",
	publicDir: "third_party",
	plugins: [
		{
			name: "production-content-security-policy",
			apply: "build",
			transformIndexHtml: {
				order: "pre",
				handler: () => [
					{
						tag: "meta",
						attrs: {
							"http-equiv": "Content-Security-Policy",
							content: contentSecurityPolicy,
						},
						injectTo: "head-prepend",
					},
				],
			},
		},
	],
	worker: {
		format: "es",
		rollupOptions: {
			output: {
				banner:
					"/*! Contains portions of MediaBunny 1.50.8. Copyright (c) 2026-present, Vanilagy and contributors. MPL-2.0 source and notices: https://enzo.mutiso.ca/tools/VodSync/open-source.html */",
			},
		},
	},
	build: {
		sourcemap: false,
	},
});
