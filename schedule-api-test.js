/**
 * Schedule Manager API Testing Script
 * Run this in the browser console while logged in as a supervisor
 */

const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port !== '5000' && window.location.port !== ''
  ? 'http://localhost:5000/api'
  : '/api';

// Test function
async function testScheduleAPI() {
  console.log('🧪 Testing Schedule Manager Endpoints...\n');
  
  // Check authentication
  console.log('📋 Auth Status:');
  console.log('- Token exists:', !!window.authToken ? '✓ Yes' : '✗ No');
  console.log('- User role:', window.currentUser?.role || 'Unknown');
  console.log('- User ID:', window.currentUser?._id || 'Unknown\n');

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${window.authToken}`
  };

  // Test 1: GET /supervisor/trainees
  console.log('1️⃣  Testing GET /api/supervisor/trainees');
  try {
    const response = await fetch(`${API_BASE}/supervisor/trainees`, {
      method: 'GET',
      headers: headers
    });
    console.log(`   Status: ${response.status} ${response.statusText}`);
    const data = await response.json();
    console.log('   Response:', data.success ? '✓ Success' : '✗ Failed');
    if (!data.success) console.log('   Error:', data.message);
    if (data.data && Array.isArray(data.data)) {
      console.log(`   Trainees found: ${data.data.length}\n`);
    }
  } catch (error) {
    console.error('   Error:', error.message + '\n');
  }

  // Test 2: Get first trainee for testing
  console.log('2️⃣  Getting first trainee for further tests...');
  let testTraineeId = null;
  try {
    const response = await fetch(`${API_BASE}/supervisor/trainees`, {
      method: 'GET',
      headers: headers
    });
    const data = await response.json();
    if (data.data && data.data.length > 0) {
      testTraineeId = data.data[0]._id;
      console.log(`   Found trainee: ${data.data[0].fullName} (${testTraineeId})\n`);
    } else {
      console.warn('   No trainees found. Cannot continue testing.\n');
      return;
    }
  } catch (error) {
    console.error('   Error:', error.message + '\n');
    return;
  }

  // Test 3: GET /supervisor/schedule/:traineeId
  console.log(`3️⃣  Testing GET /api/supervisor/schedule/${testTraineeId}`);
  try {
    const response = await fetch(`${API_BASE}/supervisor/schedule/${testTraineeId}`, {
      method: 'GET',
      headers: headers
    });
    console.log(`   Status: ${response.status} ${response.statusText}`);
    const data = await response.json();
    console.log('   Response:', data.success ? '✓ Success' : '✗ Failed');
    if (!data.success) console.log('   Error:', data.message);
    console.log('   Current Schedule:', data.data?.schedule || 'None set\n');
  } catch (error) {
    console.error('   Error:', error.message + '\n');
  }

  // Test 4: POST /supervisor/schedule/set
  console.log(`4️⃣  Testing POST /api/supervisor/schedule/set`);
  try {
    const testPayload = {
      traineeId: testTraineeId,
      startTime: '08:00',
      endTime: '17:00',
      allowsOvertime: false,
      overtimeStartTime: null,
      overtimeEndTime: null
    };
    console.log('   Payload:', testPayload);
    
    const response = await fetch(`${API_BASE}/supervisor/schedule/set`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(testPayload)
    });
    console.log(`   Status: ${response.status} ${response.statusText}`);
    const data = await response.json();
    console.log('   Response:', data.success ? '✓ Success' : '✗ Failed');
    if (!data.success) console.log('   Error:', data.message);
    else console.log('   Schedule saved:', data.data + '\n');
  } catch (error) {
    console.error('   Error:', error.message + '\n');
  }

  // Test 5: DELETE /supervisor/schedule/:traineeId
  console.log(`5️⃣  Testing DELETE /api/supervisor/schedule/${testTraineeId}`);
  try {
    const response = await fetch(`${API_BASE}/supervisor/schedule/${testTraineeId}`, {
      method: 'DELETE',
      headers: headers
    });
    console.log(`   Status: ${response.status} ${response.statusText}`);
    const data = await response.json();
    console.log('   Response:', data.success ? '✓ Success' : '✗ Failed');
    if (!data.success) console.log('   Error:', data.message);
    else console.log('   Schedule cleared\n');
  } catch (error) {
    console.error('   Error:', error.message + '\n');
  }

  console.log('✅ Testing complete! Check results above.\n');
  console.log('💡 If you see 401 errors, your token may have expired. Try logging out and back in.');
  console.log('💡 If you see 403 errors, you may not be authorized. Verify your role is "supervisor".');
  console.log('💡 If you see 404 errors, the routes may not be registered in the backend.');
}

// Run the test
testScheduleAPI();
