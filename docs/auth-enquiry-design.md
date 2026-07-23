# Customer Authentication And Enquiry Tracking Design

This document defines the planned customer authentication and WhatsApp enquiry tracking flow for the 3MT backend, website, and dashboard.

## Goals

- Customers can browse the website without logging in.
- Login or registration is required only when a customer sends a WhatsApp enquiry.
- Customers can authenticate using local account registration or Google OAuth.
- Local registration can verify the customer by either email OTP or mobile OTP.
- Google OAuth users are treated as authenticated after Google verification and can send enquiries without adding a phone number.
- Customers can update missing profile details later from the website profile section.
- Every enquiry is linked to an authenticated customer account.
- Admin users can review enquiries and understand product demand.

## Customer Authentication Flow

### Public Browsing

Customers can open these flows without login:

- Home
- About
- Services
- Products
- Product detail
- Cart browsing
- Contact page

### Enquiry Gate

When a customer clicks a WhatsApp enquiry action:

1. If the customer is logged in, save the enquiry and open WhatsApp.
2. If the customer is not logged in, show login/register.
3. After successful login/register, continue the same enquiry action.
4. Save the enquiry in the backend.
5. Open WhatsApp with the prepared message.

The app can track enquiry intent and the products selected. It cannot confirm whether the customer finally pressed Send inside WhatsApp unless WhatsApp Business API is added later.

## Local Registration Flow

Customer registration collects:

- Name
- Email, optional unless email OTP is selected
- Phone, optional unless mobile OTP is selected
- Password
- Address, optional
- OTP method: `email` or `mobile`

Validation rules:

- Name is required.
- Password is required.
- OTP method is required.
- If OTP method is `email`, email is required.
- If OTP method is `mobile`, phone is required.
- If both email and phone are provided, the selected OTP method decides where the OTP is sent.

OTP verification rules:

- OTP should be stored hashed, not as plain text.
- OTP should expire.
- OTP verification should have attempt limits.
- OTP resend should have limits.

## Google OAuth Flow

1. Customer clicks Continue with Google.
2. Google verifies the customer.
3. Website sends the Google credential to the backend.
4. Backend verifies the credential with Google.
5. Backend finds or creates the user by Google id/email.
6. Backend returns the 3MT JWT token.
7. Customer can send WhatsApp enquiry immediately.

Google users may not have a phone number. Phone and address can be added later from profile.

## Profile Flow

Logged-in customers can open profile from the website navbar.

Profile can show:

- Name
- First name
- Last name
- Email
- Phone
- Address
- Auth provider
- Email verification status
- Phone verification status

Profile can update:

- First name
- Last name
- Phone
- Address

Email changes should require re-verification in a later task.

## Enquiry Data Design

Planned collection: `Enquiry`

Important fields:

- `customer`: ObjectId reference to User
- `products`: list of enquired products
- `source`: `product_detail`, `cart`, or `contact`
- `message`: WhatsApp message prepared by the website
- `totalEstimatedPrice`
- `status`: `new`, `contacted`, `converted`, `closed`, or `spam`
- `notes`
- timestamps

Each product item should store both references and snapshots:

- `product`: ObjectId reference to Product
- `nameSnapshot`
- `priceSnapshot`
- `quantity`

Snapshots are needed because product names/prices can change later, but old enquiries should still show what the customer saw at enquiry time.

## Demand Analytics

Demand can be calculated from `Enquiry.products`.

Admin dashboard can show:

- Most enquired products
- Total enquiries per product
- Total quantity requested
- Latest enquiry date
- Category/type demand
- New enquiry count

## Security Requirements

- Auth APIs should be rate limited.
- OTP APIs should be rate limited by IP and destination.
- Enquiry creation API should be protected by login.
- Admin enquiry APIs should require admin access.
- Backend should validate name, email, phone, OTP method, product list, and source.
- Sensitive credentials must stay in environment variables.

