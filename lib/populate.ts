import fs from 'fs';

type TemplateData = Record<string, string[]>;

// Templates include placeholders in the form of {key},
// data comes in as an object with key value lists, e.g. { key: [value1, value2, ...], ... }
function populateTemplate(template: string, data: TemplateData): string {
  const keys = Object.keys(data);
  const values = Object.values(data);

  // Generate all combinations of values
  const combinations = cartesianProduct(values);
  console.log(`Generated ${combinations.length} combinations from data keys: ${keys.join(', ')}`);
  console.log(`Combinations: ${JSON.stringify(combinations)}`);

  // Populate the template for each combination
  const populatedTemplates = combinations.map((combination, combIndex) => {
    let populated = template;
    keys.forEach((key, index) => {
      const regex = new RegExp(`{${key}}`, 'g');
      populated = populated.replace(regex, combination[index]);
    });
    // Remove the leading curly brace if it's not the first combination
    if (combIndex > 0) {
      // replace first character with a comma if it's an opening curly brace
      if (populated.trim().startsWith('{')) {
        populated = populated.trim().slice(1);
        console.warn(`Warning: Opening curly brace replaced with a comma for combination index ${combIndex}.`);
      }
    }
    // Remove the closing curly brace and replace with comma if it's not the last combination
    if (combIndex < combinations.length - 1) {
      // replace last character with a comma if it's a closing curly brace
      if (populated.trim().endsWith('}')) {
        populated = populated.trim().slice(0, -1) + ',';
        console.warn(`Warning: Closing curly brace replaced with a comma for combination index ${combIndex}.`);
      }
    }
    return populated;
  });

  // Join all populated templates and close object
  return `${populatedTemplates.join('\n')}`;
}

function cartesianProduct(arrays: string[][]): string[][] {
  return arrays.reduce<string[][]>((acc, curr) => {
    return acc.flatMap(a => curr.map(b => [...a, b]));
  }, [[]]);
}

export { populateTemplate };

// Run script for loop population
if (process.argv[1] === new URL(import.meta.url).pathname) {
  while (true) {
    console.log("Enter template (Ctrl+D to end):");
    const template = fs.readFileSync(0, 'utf-8');
    console.log("Enter data as JSON { \"key\": [values], ... } (Ctrl+D to end):");
    const dataInput = fs.readFileSync(0, 'utf-8');

    let data: TemplateData;
    try {
      data = JSON.parse(dataInput);
    } catch (e) {
      console.error("Invalid JSON input. Please try again.");
      continue;
    }

    const populated = populateTemplate(template, data);
    console.log("Populated Template:");
    console.log(populated);
  }
}
