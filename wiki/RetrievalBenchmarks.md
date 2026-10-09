Scenario 1 — Developer
Daily questions about tasks, blockers, and code-related pages.


What is amruta working on?
	
What tasks are assigned to me in Oscar project?

What is the status of the ReportList feature?

Who created the API integration doc?	

Show all pages related to authentication

What are the blockers in Oscar project?

What is the Oscar MVP page about?

Who is the owner of the backend architecture doc?

What has souvik worked on this year?

Compare Oscar MVP and Oscar App — what's the difference?



Scenario 2 — Tech Team Manager
Tracking team health, assignments, and project progress.


What is priya working on currently?

Who all are working on the DataPivot project?

What projects did rahul work on in 2024?

Who is the most active team member in Oscar?

What is the current status of DataPivot AI?

List all blocked tasks in the tech team

Who is assigned to the ReportList page?

What is the ETA for Oscar project completion?

What tasks are assigned to neha in Oscar?

Which projects is ankita assigned to?


Scenario 3 — PnC (People & Culture) Team Manager
HR, onboarding, team rostering, and people management.

What are the onboarding tasks for a new hire?

Who created the leave policy document?

Tell me about the comp-off approval process

What is the leave policy?

Who owns the HR onboarding page?

List all documents related to hiring

What is divya working on?

Who is the project manager of the fellowship program?

What is the status of the onboarding flow?

Summarize the employee handbook


Scenario 4 —  lead team member of NavGurukul
Big picture: cross-project visibility, risks, and summaries.



Give me a summary of the Oscar project

What are the risks mentioned for DataPivot AI?

What is the overall status of all ongoing projects?

Who is the project manager of DataPivot AI?

What has the tech team worked on in 2024?

Compare the Oscar MVP and DataPivot AI scope

What is the cost estimation for the Oscar project?

Who is the least active team member in Oscar?

What projects are currently blocked?

When will the Oscar project be completed?





Extra 


What is the leave policy?

How do I request reimbursement?

Who owns admissions?

How do we onboard a new team member?

What is the process for creating a new batch?

Who approves travel expenses?

What are the expectations for fellows?

Where is the SOP for partner reporting?









1. Fixed cases (re-verify end to end)

"How many projects are there in total?"
"Which pages does amruta own?"
"Which pages were updated last week?"
"List pages updated in the last 7 days"

2. History sequence (same chat)

"What is the goal of notion chatbot?"
"What is its status?" (expect the 🤖 Notion Chatbot project, status In progress)
"Who owns it?" (expect Tamanna a and Laxmi Yadav)
"Now tell me about zuvy"
"What is its status?" (expect Zuvy, not Notion Chatbot)

3. No-history check (fresh chat)

"What is its status?" (expect clarification, not a guess)
"Tell me about it"

4. Still-broken cases (expect failures)

"Explain the onboarding process" (compare against the real new-hire onboarding page)
"What is laxmi working on?" (should include the Notion-to-PostgreSQL sync page, status Done)
"Hi, kaise ho?" (check whether the reply is Hinglish or English)

5. Phrasing variants (does the regex only match one wording?)

"Total number of projects?"
"What pages does laxmi own?"
"Show me pages edited this month"
"Which pages did amruta update recently?"

6. Edge cases

"How many projects are in progress?" (a filtered count, not the total)
"Which pages does nobody own?"
"What's the weather today?"