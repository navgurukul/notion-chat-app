import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import * as dotenv from "dotenv";

dotenv.config();

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.S3_BUCKET_NAME!;

async function searchS3Files(searchTerm: string) {
  console.log(`🔍 Searching S3 bucket '${BUCKET}' for: "${searchTerm}"\n`);

  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: "notion/pages/",
    });

    const response = await s3.send(listCommand);
    const files = response.Contents || [];
    
    console.log(`📁 Total files in bucket: ${files.length}\n`);
    
    let matchCount = 0;
    
    for (const file of files) {
      if (!file.Key) continue;
      
      const getCommand = new GetObjectCommand({
        Bucket: BUCKET,
        Key: file.Key,
      });
      
      const object = await s3.send(getCommand);
      const content = await object.Body?.transformToString();
      
      if (content && content.toLowerCase().includes(searchTerm.toLowerCase())) {
        matchCount++;
        const data = JSON.parse(content);
        console.log(`\n${'='.repeat(80)}`);
        console.log(`✅ Match #${matchCount}:`);
        console.log(`${'='.repeat(80)}`);
        console.log(`File: ${file.Key}`);
        console.log(`Title: ${data.title}`);
        console.log(`URL: ${data.url}`);
        console.log(`Last Edited: ${data.lastEdited}`);
        console.log(`\n--- FULL CONTENT ---\n`);
        console.log(data.content);
        console.log(`\n--- END OF CONTENT ---`);
        console.log(`${'='.repeat(80)}\n`);
      }
    }
    
    if (matchCount === 0) {
      console.log(`❌ No files found containing "${searchTerm}"`);
      console.log(`\n💡 This means either:`);
      console.log(`   1. The content doesn't exist in your Notion workspace`);
      console.log(`   2. It exists but wasn't exported to S3`);
      console.log(`   3. The page exists but doesn't contain that keyword`);
    } else {
      console.log(`\n✅ Found ${matchCount} file(s) containing "${searchTerm}"`);
    }
    
  } catch (error) {
    console.error("❌ Error searching S3:", error);
    throw error;
  }
}

const searchTerm = process.argv[2] || "reimbursement";
searchS3Files(searchTerm).catch(console.error);
