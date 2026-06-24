# 3MT Server

Express and MongoDB backend for authentication, products, product images, and orders.

## Requirements

- Node.js 18 or newer
- npm
- MongoDB connection
- Cloudinary account

## Environment

Copy `.env.example` to `.env` and provide:

```env
PORT=8080
NODE_ENV=development
CLIENT_URLS=http://localhost:3000,http://127.0.0.1:3000,https://3mt-machine-tools.netlify.app,https://3mt-dashboard.netlify.app
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
CLOUDINARY_CLOUD_NAME=your_cloudinary_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret
```

`CLIENT_URLS` contains frontend origins, not backend URLs. Keep values comma-separated and omit paths and trailing slashes.

## Commands

```bash
npm install
npm run dev
npm start
npm run check
npm run verify
```

- `npm run dev` starts Nodemon for local development.
- `npm start` runs the server normally.
- `npm run check` syntax-checks every first-party server module without connecting to external services.
- `npm run verify` runs the server verification check.

## Health Check

```text
GET /api/health
```

Production backend:

`https://threemt-server.onrender.com`

## Product Read APIs

- `GET /api/products`
- `GET /api/products/search?q=grinder&limit=8`
- `GET /api/products/:id`
- `GET /api/products/:id/related?limit=30`

See `PROJECT_MEMORY.md` in the project root for the complete API and feature inventory.
