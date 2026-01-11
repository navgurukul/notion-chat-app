import { Client } from "@notionhq/client";

const notion = new Client({
    auth: process.env.NOTION_TOKEN,
});

export async function getDatabaseContent(databaseId: string) {
    try {
        const response = await notion.databases.query({
            database_id: databaseId,
        });

        // Extract text content from the database rows
        // This is a simplified version; in a real app, you'd handle different property types
        const content = response.results.map((page: any) => {
            const properties = page.properties;
            return Object.values(properties)
                .map((prop: any) => {
                    if (prop.type === "title") return prop.title[0]?.plain_text || "";
                    if (prop.type === "rich_text") return prop.rich_text[0]?.plain_text || "";
                    if (prop.type === "select") return prop.select?.name || "";
                    if (prop.type === "multi_select") return prop.multi_select.map((s: any) => s.name).join(", ");
                    return "";
                })
                .join(" | ");
        }).join("\n");

        return content;
    } catch (error) {
        console.error("Notion Error:", error);
        throw error;
    }
}
