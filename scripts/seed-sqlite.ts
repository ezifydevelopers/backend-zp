#!/usr/bin/env ts-node
/**
 * Seed SQLite database with default data
 * Creates company, branch, and admin user for first-time use
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import * as path from 'path';
import * as os from 'os';

const sqlitePath = path.join(os.homedir(), '.zapeera', 'data', 'zapeera.db');
process.env.DATABASE_URL = `file:${sqlitePath}`;

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding SQLite database...');
  console.log(`📁 Database: ${sqlitePath}`);

  try {
    // Check if any users exist
    const userCount = await prisma.user.count();

    if (userCount > 0) {
      console.log(`✅ Database already has ${userCount} users - skipping seed`);
      return;
    }

    console.log('📝 No users found - creating default data...');

    // Hash password for default admin
    const hashedPassword = await bcrypt.hash('admin123', 12);

    // Create company first
    const company = await prisma.company.upsert({
      where: { name: 'My Pharmacy' },
      update: {},
      create: {
        name: 'My Pharmacy',
        description: 'Local pharmacy business',
        address: '123 Main Street',
        phone: '+1234567890',
        email: 'admin@pharmacy.local',
        businessType: 'PHARMACY',
        isActive: true
      }
    });
    console.log('✅ Company created:', company.name);

    // Create branch (using findFirst + create since unique constraint is on name+companyId)
    let branch = await prisma.branch.findFirst({
      where: {
        name: 'Main Branch',
        companyId: company.id
      }
    });

    if (!branch) {
      branch = await prisma.branch.create({
        data: {
          name: 'Main Branch',
          address: '123 Main Street',
          phone: '+1234567890',
          email: 'main@pharmacy.local',
          companyId: company.id,
          isActive: true
        }
      });
    }
    console.log('✅ Branch created:', branch.name);

    // Create superadmin user
    const superadmin = await prisma.user.upsert({
      where: { username: 'superadmin' },
      update: { isActive: true },
      create: {
        username: 'superadmin',
        email: 'superadmin@pharmacy.local',
        password: hashedPassword,
        name: 'Super Admin',
        role: 'SUPERADMIN',
        branchId: branch.id,
        companyId: company.id,
        isActive: true
      }
    });
    console.log('✅ Superadmin created:', superadmin.username);

    // Create admin user
    const admin = await prisma.user.upsert({
      where: { username: 'admin' },
      update: { isActive: true },
      create: {
        username: 'admin',
        email: 'admin@pharmacy.local',
        password: hashedPassword,
        name: 'Admin User',
        role: 'ADMIN',
        branchId: branch.id,
        companyId: company.id,
        createdBy: superadmin.id,
        isActive: true
      }
    });
    console.log('✅ Admin created:', admin.username);

    // Update superadmin with createdBy
    await prisma.user.update({
      where: { id: superadmin.id },
      data: { createdBy: superadmin.id }
    });

    console.log('\n✅ SQLite database seeded successfully!');
    console.log('\n📋 Default login credentials:');
    console.log('   Username: superadmin');
    console.log('   Password: admin123');
    console.log('\n   Username: admin');
    console.log('   Password: admin123');

  } catch (error: any) {
    console.error('❌ Error seeding database:', error.message);
    throw error;
  }
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
