// server.js
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Google Sheets configuration
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const NUTRIENT_SHEET = 'NutrientData';
const RECIPE_SHEET = 'Recipes';
const RECIPE_ITEMS_SHEET = 'RecipeItems';
const UNIT_MAP_SHEET = 'UnitMap';

// Google Sheets authentication
// Google Sheets authentication (prefers env var in production)
async function getGoogleSheetsClient() {
  const hasInlineCreds = !!process.env.GOOGLE_CREDENTIALS;

  const auth = new google.auth.GoogleAuth({
    ...(hasInlineCreds
      ? { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS) } // Render / prod
      : { keyFile: 'credentials.json' } // Local dev
    ),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

// Nutrient calculation functions
function calculateVitaminD(foodCode, chocal, oh25d3) {
    // For food codes A001 to L004, use D2 directly
    if (foodCode >= 'A001' && foodCode <= 'L004') {
        return chocal; // Use D2 value directly
    }
    // For food codes M001 to S010, calculate D3 equivalents
    if (foodCode >= 'M001' && foodCode <= 'S010') {
        return chocal + (5 * oh25d3);
    }
    return 0;
}

function calculateVitaminA(retinol, betaCarotene, alphaCarotene) {
    return retinol + (betaCarotene / 12) + (alphaCarotene / 24);
}

function calculateOmega3Veg(c18_3n3) {
    return c18_3n3;
}

function calculateOmega6Veg(c18_2n6) {
    return c18_2n6;
}

function calculateOmega3NonVeg(c18_3n3, c20_5n3, c22_6n3, c22_5n3 = 0) {
    return c18_3n3 + c20_5n3 + c22_6n3 + c22_5n3;
}

function calculateOmega6NonVeg(c18_2n6, c20_4n6, c18_3n6 = 0) {
    return c18_2n6 + c20_4n6 + c18_3n6;
}

// Get nutrient data from Google Sheets
async function getNutrientData(sheets) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${NUTRIENT_SHEET}!A:AH` // Adjust range based on your columns
        });
        
        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            return [];
        }
        
        const headers = rows[0];
        const data = rows.slice(1).map(row => {
            const item = {};
            headers.forEach((header, index) => {
                item[header] = row[index] || '';
            });
            return item;
        });
        
        return data;
    } catch (error) {
        console.error('Error fetching nutrient data:', error);
        throw error;
    }
}

// Get unit conversions from Google Sheets
async function getUnitConversions(sheets) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${UNIT_MAP_SHEET}!A:D`
        });
        
        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            return {};
        }
        
        const unitMap = {};
        rows.slice(1).forEach(row => {
            if (row[0] && row[1]) {
                unitMap[`${row[0]}_${row[1]}`] = {
                    gPerUnit: parseFloat(row[2]) || 1,
                    density: parseFloat(row[3]) || 1
                };
            }
        });
        
        return unitMap;
    } catch (error) {
        console.error('Error fetching unit conversions:', error);
        throw error;
    }
}

// Calculate scaled nutrition for an ingredient
function calculateScaledNutrition(nutrientData, quantity) {
    const factor = quantity / 100; // IFCT data is per 100g
    const scaled = {};
    
    // Scale all numeric nutrients
    const numericFields = [
        'Protein (g)', 'Fat (g)', 'Total fibre (g)', 'Carbohydrate (g)',
        'Energy (Kcal)', 'Energy (KJ)', 'Thiamine, B1 (mg)', 'Riboflavin, B2 (mg)',
        'Niacin, B3 (mg)', 'Pantothenic Acid B5 (mg)', 'Pyridoxine B6 (mg)',
        'Biotin, B7 (µg)', 'Folate, B9 (µg)', 'Vitamin C (mg)', 'Vitamin A (µg)',
        'Vitamin D (µg)', 'VITE (mg)', 'VITK1 (µg)', 'Iron (Fe) mg',
        'Calcium (Ca) mg', 'Magnesium (Mg) mg', 'Zinc (Zn) mg', 'Selenium (Se) µg',
        'Sodium (Na) mg', 'Potassium (K) mg', 'Phosphorus (P) mg', 'Cobalt (Co) mg',
        'Omega 3 (mg)', 'Omega 6 (mg)', 'MUFA', 'PUFA', 'SATURATED FAT', 'TOTAL SUGAR (g)'
    ];
    
    numericFields.forEach(field => {
        const value = parseFloat(nutrientData[field]) || 0;
        scaled[field] = value * factor;
    });
    
    return scaled;
}

// API Routes

// Get all ingredients for search
app.get('/api/ingredients', async (req, res) => {
    try {
        const sheets = await getGoogleSheetsClient();
        const nutrientData = await getNutrientData(sheets);
        
        const ingredients = nutrientData.map(item => ({
            code: item['Food code'],
            name: item['Food Name'],
            protein: parseFloat(item['Protein (g)']) || 0,
            fat: parseFloat(item['Fat (g)']) || 0,
            carbs: parseFloat(item['Carbohydrate (g)']) || 0,
            fiber: parseFloat(item['Total fibre (g)']) || 0,
            energy: parseFloat(item['Energy (Kcal)']) || 0
        }));
        
        res.json(ingredients);
    } catch (error) {
        console.error('Error fetching ingredients:', error);
        res.status(500).json({ error: 'Failed to fetch ingredients' });
    }
});

// Create a new recipe
app.post('/api/recipes', async (req, res) => {
    try {
        const sheets = await getGoogleSheetsClient();
        const nutrientData = await getNutrientData(sheets);
        const unitConversions = await getUnitConversions(sheets);
        
        const {
            recipeName,
            yield: recipeYield,
            method,
            healthBenefits,
            precautions,
            source,
            mealTags,
            ingredients
        } = req.body;
        
        const recipeId = uuidv4();
        const timestamp = new Date().toISOString();
        
        // Calculate total nutrition for the recipe
        let totalNutrition = {
            energy: 0,
            protein: 0,
            fat: 0,
            carbs: 0,
            fiber: 0,
            vitaminD: 0,
            vitaminA: 0,
            omega3: 0,
            omega6: 0,
            energyKJ: 0,
            thiamine: 0,
            riboflavin: 0,
            niacin: 0,
            pantothenicAcid: 0,
            pyridoxine: 0,
            biotin: 0,
            folate: 0,
            vitaminC: 0,
            vitaminE: 0,
            vitaminK1: 0,
            iron: 0,
            calcium: 0,
            magnesium: 0,
            zinc: 0,
            selenium: 0,
            sodium: 0,
            potassium: 0,
            phosphorus: 0,
            cobalt: 0,
            mufa: 0,
            pufa: 0,
            saturatedFat: 0,
            totalSugar: 0
        };
        
        // Prepare recipe items data
        const recipeItems = [];
        
        for (const ingredient of ingredients) {
            const nutrient = nutrientData.find(n => n['Food code'] === ingredient.code);
            if (!nutrient) continue;
            
            const quantityInGrams = ingredient.quantityInGrams;
            const scaled = calculateScaledNutrition(nutrient, quantityInGrams);
            
            // Add to total nutrition
            totalNutrition.energy += scaled['Energy (Kcal)'];
            totalNutrition.protein += scaled['Protein (g)'];
            totalNutrition.fat += scaled['Fat (g)'];
            totalNutrition.carbs += scaled['Carbohydrate (g)'];
            totalNutrition.fiber += scaled['Total fibre (g)'];
            totalNutrition.vitaminD += scaled['Vitamin D (µg)'];
            totalNutrition.vitaminA += scaled['Vitamin A (µg)'];
            totalNutrition.omega3 += scaled['Omega 3 (mg)'];
            totalNutrition.omega6 += scaled['Omega 6 (mg)'];
            totalNutrition.energyKJ += scaled['Energy (KJ)'];
            totalNutrition.thiamine += scaled['Thiamine, B1 (mg)'];
            totalNutrition.riboflavin += scaled['Riboflavin, B2 (mg)'];
            totalNutrition.niacin += scaled['Niacin, B3 (mg)'];
            totalNutrition.pantothenicAcid += scaled['Pantothenic Acid B5 (mg)'];
            totalNutrition.pyridoxine += scaled['Pyridoxine B6 (mg)'];
            totalNutrition.biotin += scaled['Biotin, B7 (µg)'];
            totalNutrition.folate += scaled['Folate, B9 (µg)'];
            totalNutrition.vitaminC += scaled['Vitamin C (mg)'];
            totalNutrition.vitaminE += scaled['VITE (mg)'];
            totalNutrition.vitaminK1 += scaled['VITK1 (µg)'];
            totalNutrition.iron += scaled['Iron (Fe) mg'];
            totalNutrition.calcium += scaled['Calcium (Ca) mg'];
            totalNutrition.magnesium += scaled['Magnesium (Mg) mg'];
            totalNutrition.zinc += scaled['Zinc (Zn) mg'];
            totalNutrition.selenium += scaled['Selenium (Se) µg'];
            totalNutrition.sodium += scaled['Sodium (Na) mg'];
            totalNutrition.potassium += scaled['Potassium (K) mg'];
            totalNutrition.phosphorus += scaled['Phosphorus (P) mg'];
            totalNutrition.cobalt += scaled['Cobalt (Co) mg'];
            totalNutrition.mufa += scaled['MUFA'];
            totalNutrition.pufa += scaled['PUFA'];
            totalNutrition.saturatedFat += scaled['SATURATED FAT'];
            totalNutrition.totalSugar += scaled['TOTAL SUGAR (g)'];
            
            // Prepare recipe item row
            recipeItems.push([
                timestamp,
                recipeId,
                ingredient.lineNo,
                ingredient.code,
                ingredient.name,
                quantityInGrams,
                scaled['Energy (Kcal)'],
                scaled['Protein (g)'],
                scaled['Fat (g)'],
                scaled['Carbohydrate (g)'],
                scaled['Total fibre (g)'],
                scaled['Vitamin D (µg)'],
                scaled['Vitamin A (µg)'],
                scaled['Omega 3 (mg)'],
                scaled['Omega 6 (mg)'],
                scaled['Energy (KJ)'],
                scaled['Thiamine, B1 (mg)'],
                scaled['Riboflavin, B2 (mg)'],
                scaled['Niacin, B3 (mg)'],
                scaled['Pantothenic Acid B5 (mg)'],
                scaled['Pyridoxine B6 (mg)'],
                scaled['Biotin, B7 (µg)'],
                scaled['Folate, B9 (µg)'],
                scaled['Vitamin C (mg)'],
                scaled['VITE (mg)'],
                scaled['VITK1 (µg)'],
                scaled['Iron (Fe) mg'],
                scaled['Calcium (Ca) mg'],
                scaled['Magnesium (Mg) mg'],
                scaled['Zinc (Zn) mg'],
                scaled['Selenium (Se) µg'],
                scaled['Sodium (Na) mg'],
                scaled['Potassium (K) mg'],
                scaled['Phosphorus (P) mg'],
                scaled['Cobalt (Co) mg'],
                scaled['MUFA'],
                scaled['PUFA'],
                scaled['SATURATED FAT'],
                scaled['TOTAL SUGAR (g)']
            ]);
        }
        
        // Calculate omega-3 to omega-6 ratio
        const omega3To6Ratio = totalNutrition.omega6 > 0 ? 
            (totalNutrition.omega3 / totalNutrition.omega6).toFixed(2) : 0;
        
        // Prepare recipe row
        const recipeRow = [
            timestamp,
            recipeId,
            recipeName,
            recipeYield,
            method,
            healthBenefits,
            precautions,
            source,
            mealTags,
            totalNutrition.energy.toFixed(2),
            totalNutrition.protein.toFixed(2),
            totalNutrition.fat.toFixed(2),
            totalNutrition.carbs.toFixed(2),
            totalNutrition.fiber.toFixed(2),
            totalNutrition.vitaminD.toFixed(2),
            totalNutrition.vitaminA.toFixed(2),
            totalNutrition.omega3.toFixed(2),
            totalNutrition.omega6.toFixed(2),
            omega3To6Ratio,
            totalNutrition.energyKJ.toFixed(2),
            totalNutrition.thiamine.toFixed(3),
            totalNutrition.riboflavin.toFixed(3),
            totalNutrition.niacin.toFixed(2),
            totalNutrition.pantothenicAcid.toFixed(2),
            totalNutrition.pyridoxine.toFixed(3),
            totalNutrition.biotin.toFixed(2),
            totalNutrition.folate.toFixed(2),
            totalNutrition.vitaminC.toFixed(2),
            totalNutrition.vitaminE.toFixed(2),
            totalNutrition.vitaminK1.toFixed(2),
            totalNutrition.iron.toFixed(2),
            totalNutrition.calcium.toFixed(2),
            totalNutrition.magnesium.toFixed(2),
            totalNutrition.zinc.toFixed(2),
            totalNutrition.selenium.toFixed(2),
            totalNutrition.sodium.toFixed(2),
            totalNutrition.potassium.toFixed(2),
            totalNutrition.phosphorus.toFixed(2),
            totalNutrition.cobalt.toFixed(3),
            totalNutrition.mufa.toFixed(2),
            totalNutrition.pufa.toFixed(2),
            totalNutrition.saturatedFat.toFixed(2),
            totalNutrition.totalSugar.toFixed(2),
            recipeYield,
            (totalNutrition.energy / recipeYield).toFixed(2),
            (totalNutrition.protein / recipeYield).toFixed(2),
            (totalNutrition.fat / recipeYield).toFixed(2),
            (totalNutrition.carbs / recipeYield).toFixed(2),
            (totalNutrition.fiber / recipeYield).toFixed(2)
        ];
        
        // Append to Google Sheets
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${RECIPE_SHEET}!A:A`,
            valueInputOption: 'RAW',
            resource: {
                values: [recipeRow]
            }
        });
        
        if (recipeItems.length > 0) {
            await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: `${RECIPE_ITEMS_SHEET}!A:A`,
                valueInputOption: 'RAW',
                resource: {
                    values: recipeItems
                }
            });
        }
        
        res.json({
            success: true,
            recipeId,
            message: 'Recipe saved successfully',
            nutrition: {
                total: totalNutrition,
                perServing: {
                    energy: (totalNutrition.energy / recipeYield).toFixed(2),
                    protein: (totalNutrition.protein / recipeYield).toFixed(2),
                    fat: (totalNutrition.fat / recipeYield).toFixed(2),
                    carbs: (totalNutrition.carbs / recipeYield).toFixed(2),
                    fiber: (totalNutrition.fiber / recipeYield).toFixed(2)
                }
            }
        });
        
    } catch (error) {
        console.error('Error creating recipe:', error);
        res.status(500).json({ error: 'Failed to create recipe' });
    }
});

// Get all recipes
app.get('/api/recipes', async (req, res) => {
    try {
        const sheets = await getGoogleSheetsClient();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${RECIPE_SHEET}!A:AN` // Adjust based on your columns
        });
        
        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            return res.json([]);
        }
        
        const headers = rows[0];
        const recipes = rows.slice(1).map(row => {
            const recipe = {};
            headers.forEach((header, index) => {
                recipe[header] = row[index] || '';
            });
            return recipe;
        });
        
        res.json(recipes);
    } catch (error) {
        console.error('Error fetching recipes:', error);
        res.status(500).json({ error: 'Failed to fetch recipes' });
    }
});

// Get recipe details with ingredients
app.get('/api/recipes/:id', async (req, res) => {
    try {
        const sheets = await getGoogleSheetsClient();
        const recipeId = req.params.id;
        
        // Get recipe
        const recipeResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${RECIPE_SHEET}!A:AN`
        });
        
        const recipeRows = recipeResponse.data.values;
        const recipeHeaders = recipeRows[0];
        const recipeRow = recipeRows.find(row => row[1] === recipeId); // RecipeID is in column B
        
        if (!recipeRow) {
            return res.status(404).json({ error: 'Recipe not found' });
        }
        
        const recipe = {};
        recipeHeaders.forEach((header, index) => {
            recipe[header] = recipeRow[index] || '';
        });
        
        // Get recipe items
        const itemsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${RECIPE_ITEMS_SHEET}!A:AM`
        });
        
        const itemRows = itemsResponse.data.values;
        const itemHeaders = itemRows[0];
        const items = itemRows
            .slice(1)
            .filter(row => row[1] === recipeId) // RecipeID is in column B
            .map(row => {
                const item = {};
                itemHeaders.forEach((header, index) => {
                    item[header] = row[index] || '';
                });
                return item;
            });
        
        res.json({
            recipe,
            items
        });
    } catch (error) {
        console.error('Error fetching recipe details:', error);
        res.status(500).json({ error: 'Failed to fetch recipe details' });
    }
});
// Root route (homepage check)
app.get('/', (req, res) => {
  res.send('Recipe Builder Backend is running 🚀');
});

// Health check route
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});
app.get('/api/recipes/ping', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});