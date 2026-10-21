# 3MT Server

Express and MongoDB backend for authentication, products, product review requests, product images, enquiries, and orders.

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
GOOGLE_CLIENT_ID=your_google_oauth_client_id
CLOUDINARY_CLOUD_NAME=your_cloudinary_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret
```

`CLIENT_URLS` contains frontend origins, not backend URLs. Keep values comma-separated and omit paths and trailing slashes.

`GOOGLE_CLIENT_ID` must match the OAuth client ID used by the frontend Google Sign-In button. The backend verifies Google credentials against this value before issuing a 3MT JWT.

## Commands

```bash
npm install
npm run dev
npm start
npm run check
npm test
npm run verify
```

- `npm run dev` starts Nodemon for local development.
- `npm start` runs the server normally.
- `npm run check` syntax-checks every first-party server module without connecting to external services.
- `npm test` runs the Node test suite without connecting to MongoDB or Cloudinary.
- `npm run verify` runs syntax checks followed by the complete backend test suite.

## Second-Hand Product Workflow

The backend supports new and second-hand products without changing the existing product endpoints.

- `condition`: `new` or `used`
- `availabilityType`: `sale`, `rent`, or `both`
- `availabilityStatus`: `available`, `on_rent`, `unavailable`, or `sold`
- Rental listings require `rentalPrice` and `rentPeriod` (`day`, `week`, or `month`).
- Sale listings require a positive `price`.
- Category and brand values are trimmed and converted to uppercase before persistence.
- Existing records without the new fields remain compatible through the defaults `new`, `sale`, and `available`.

Employees submit products through `POST /api/pending-products`. New requests always start with listing availability `available` and review status `pending`. An admin may edit the request and approve it; approval validates and copies the product fields and Cloudinary image references into the main `Product` collection. The `PendingProduct` record remains as review history until an admin deletes it.

The backend tests cover shared validation, employee submission preparation, admin approval payload creation, Product and PendingProduct schemas, and legacy product defaults.

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
