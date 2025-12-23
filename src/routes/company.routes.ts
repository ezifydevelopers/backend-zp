import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getCompanies,
  getCompany,
  createCompany,
  updateCompany,
  deleteCompany,
  getCompanyStats,
  updateCompanyBusinessType
} from '../controllers/company.controller';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Company routes
router.get('/', getCompanies);                    // GET /api/companies
router.get('/:id', getCompany);                   // GET /api/companies/:id
router.post('/', createCompany);                  // POST /api/companies
router.put('/:id', updateCompany);                // PUT /api/companies/:id
router.patch('/:id/business-type', updateCompanyBusinessType); // PATCH /api/companies/:id/business-type
router.delete('/:id', deleteCompany);             // DELETE /api/companies/:id
router.get('/:id/stats', getCompanyStats);        // GET /api/companies/:id/stats

export default router;
