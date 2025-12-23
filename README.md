# MediBill Pulse Backend

A comprehensive backend API for the MediBill Pulse Pharmacy Management System built with Node.js, Express, TypeScript, and Prisma.

## Features

- �� **Authentication & Authorization** - JWT-based auth with role-based access control
- 👥 **User Management** - Multi-role user system (SuperAdmin, Admin, Manager, Cashier)
- 🏢 **Branch Management** - Multi-branch pharmacy support
- 💊 **Product Management** - Complete inventory management with stock tracking
- 👤 **Customer Management** - Customer profiles with loyalty points
- 🛒 **POS System** - Complete point of sale with receipt generation
- 📊 **Reports & Analytics** - Sales and inventory reports
- 📈 **Dashboard** - Real-time statistics and charts

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Language**: TypeScript
- **Database**: PostgreSQL
- **ORM**: Prisma
- **Authentication**: JWT
- **Validation**: Joi
- **Security**: Helmet, CORS, Rate Limiting

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- PostgreSQL (v13 or higher)
- npm or yarn

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment Setup**
   ```bash
   cp .env.example .env
   ```
   
   Update the `.env` file with your database credentials:
   ```env
   DATABASE_URL="postgresql://username:password@localhost:5432/medibill_pulse?schema=public"
   JWT_SECRET="your-super-secret-jwt-key"
   PORT=5000
   NODE_ENV="development"
   FRONTEND_URL="http://localhost:5173"
   ```

4. **Database Setup**
   ```bash
   # Generate Prisma client
   npm run db:generate
   
   # Push schema to database
   npm run db:push
   
   # Seed the database with sample data
   npm run db:seed
   ```

5. **Start the server**
   ```bash
   # Development mode
   npm run dev
   
   # Production mode
   npm run build
   npm start
   ```

The API will be available at `http://localhost:5000`

## API Endpoints

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/register` - User registration
- `GET /api/auth/profile` - Get user profile

### Users
- `GET /api/users` - Get all users (Manager+)
- `GET /api/users/:id` - Get user by ID (Manager+)
- `POST /api/users` - Create user (Admin+)
- `PUT /api/users/:id` - Update user (Admin+)
- `DELETE /api/users/:id` - Delete user (Admin+)

### Branches
- `GET /api/branches` - Get all branches
- `GET /api/branches/:id` - Get branch by ID
- `POST /api/branches` - Create branch (Admin+)
- `PUT /api/branches/:id` - Update branch (Admin+)
- `DELETE /api/branches/:id` - Delete branch (Admin+)

### Products
- `GET /api/products` - Get all products
- `GET /api/products/:id` - Get product by ID
- `POST /api/products` - Create product (Manager+)
- `PUT /api/products/:id` - Update product (Manager+)
- `DELETE /api/products/:id` - Delete product (Manager+)
- `PATCH /api/products/:id/stock` - Update stock (Manager+)

### Customers
- `GET /api/customers` - Get all customers
- `GET /api/customers/:id` - Get customer by ID
- `POST /api/customers` - Create customer (Manager+)
- `PUT /api/customers/:id` - Update customer (Manager+)
- `DELETE /api/customers/:id` - Delete customer (Manager+)

### Sales
- `GET /api/sales` - Get all sales
- `GET /api/sales/:id` - Get sale by ID
- `POST /api/sales` - Create sale

### Reports
- `GET /api/reports/sales` - Sales report (Manager+)
- `GET /api/reports/inventory` - Inventory report (Manager+)

### Dashboard
- `GET /api/dashboard/stats` - Dashboard statistics
- `GET /api/dashboard/chart` - Sales chart data

## Database Schema

The database includes the following main entities:

- **Users** - System users with role-based access
- **Branches** - Pharmacy branches
- **Categories** - Product categories
- **Suppliers** - Product suppliers
- **Products** - Medicine inventory
- **Customers** - Customer profiles
- **Sales** - Sales transactions
- **SaleItems** - Individual sale items
- **Receipts** - Sale receipts
- **StockMovements** - Inventory tracking

## Authentication

The API uses JWT tokens for authentication. Include the token in the Authorization header:

```
Authorization: Bearer <your-jwt-token>
```

## Role-Based Access Control

- **SuperAdmin**: Full system access
- **Admin**: Branch and user management
- **Manager**: Product, customer, and report management
- **Cashier**: Sales and basic operations

## Error Handling

All API responses follow a consistent format:

```json
{
  "success": true|false,
  "data": {...},
  "message": "Error message (if applicable)"
}
```

## Development

### Available Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run db:generate` - Generate Prisma client
- `npm run db:push` - Push schema changes to database
- `npm run db:migrate` - Run database migrations
- `npm run db:seed` - Seed database with sample data
- `npm run db:studio` - Open Prisma Studio

### Database Management

```bash
# Create a new migration
npx prisma migrate dev --name migration_name

# Reset database
npx prisma migrate reset

# View database in Prisma Studio
npm run db:studio
```

## Production Deployment

1. Set `NODE_ENV=production` in your environment
2. Use a production PostgreSQL database
3. Set a strong `JWT_SECRET`
4. Configure proper CORS origins
5. Use a process manager like PM2
6. Set up SSL/TLS certificates
7. Configure reverse proxy (nginx)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT License.
"# pharmachy-backend" 
